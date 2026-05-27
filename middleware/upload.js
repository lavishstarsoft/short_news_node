const multer = require('multer');
const sharp = require('sharp');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { s3Client, bucketName, publicUrl } = require('../config/cloudflare');
const path = require('path');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');

// Set explicit ffmpeg and ffprobe paths to resolve PM2 environment issues
const ffmpegPaths = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
const ffprobePaths = ['/usr/bin/ffprobe', '/usr/local/bin/ffprobe'];

for (const p of ffmpegPaths) {
    if (fs.existsSync(p)) {
        ffmpeg.setFfmpegPath(p);
        break;
    }
}
for (const p of ffprobePaths) {
    if (fs.existsSync(p)) {
        ffmpeg.setFfprobePath(p);
        break;
    }
}

const os = require('os');
const { promisify } = require('util');
const writeFile = promisify(fs.writeFile);
const unlink = promisify(fs.unlink);
const mkdir = promisify(fs.mkdir);

// Use memory storage to process files before uploading to R2
const memoryStorage = multer.memoryStorage();

/**
 * Helper function to upload buffer to Cloudflare R2
 */
const uploadToR2 = async (buffer, folder, originalName, mimetype) => {
    let fileExtension = path.extname(originalName) || `.${mimetype.split('/')[1]}`;

    // Force .webp if we processed it to webp
    if (mimetype === 'image/webp' && fileExtension !== '.webp') {
        fileExtension = '.webp';
    }

    const fileName = `${crypto.randomBytes(16).toString('hex')}${fileExtension}`;
    const key = `${folder}/${fileName}`;

    try {
        const upload = new Upload({
            client: s3Client,
            params: {
                Bucket: bucketName,
                Key: key,
                Body: buffer,
                ContentType: mimetype,
            },
        });

        await upload.done();
        return `${publicUrl}/${key}`;
    } catch (error) {
        console.error('Error uploading to Cloudflare R2:', error);
        throw new Error('Failed to upload file to storage');
    }
};

/**
 * Creates a middleware factory that mimics multer's interface but adds Sharp and R2 processing
 */
const createMulterR2Interface = (options = {}) => {
    const {
        folder = 'general',
        width,
        height,
        resize = false,
        limitSize = 10 * 1024 * 1024
    } = options;

    const multerInstance = multer({
        storage: memoryStorage,
        limits: { fileSize: limitSize }
    });

    return {
        single: (fieldName) => {
            const middleware = multerInstance.single(fieldName);
            return (req, res, next) => {
                middleware(req, res, async (err) => {
                    if (err) return res.status(400).json({ error: err.message });
                    if (!req.file) return next();

                    try {
                        let buffer = req.file.buffer;
                        let mimetype = req.file.mimetype;
                        let folderName = folder;
                        let thumbnailPath = null;

                        // Image processing with Sharp
                        if (mimetype.startsWith('image/')) {
                            // 1. Generate Main Image (1080px or original)
                            let sharpInstance = sharp(buffer);
                            if (resize && width && height) {
                                sharpInstance = sharpInstance.resize(width, height, { fit: 'cover' });
                            }
                            const mainBuffer = await sharpInstance.webp({ quality: 80 }).toBuffer();
                            const mainMimetype = 'image/webp';

                            // Upload Main
                            req.file.path = await uploadToR2(mainBuffer, folderName, req.file.originalname, mainMimetype);

                            // 2. Generate Thumbnail (400px width)
                            const thumbBuffer = await sharp(buffer)
                                .resize(400) // Small width for thumbnails
                                .webp({ quality: 60 })
                                .toBuffer();

                            thumbnailPath = await uploadToR2(thumbBuffer, folderName, `thumb_${req.file.originalname}`, 'image/webp');
                            req.file.thumbnailPath = thumbnailPath;
                        } else if (mimetype.startsWith('video/')) {
                            // Automatically switch to video folder if it's a video and we were in images
                            folderName = folder === 'short_news_images' ? 'short_news_videos' : folder;
                            req.file.path = await uploadToR2(buffer, folderName, req.file.originalname, mimetype);

                            // 🎥 VIDEO THUMBNAIL GENERATION
                            try {
                                console.log('🎬 Generating thumbnail for video...');
                                const tempId = crypto.randomBytes(8).toString('hex');
                                const tempDir = path.join(os.tmpdir(), 'short_news_uploads');
                                
                                // Ensure temp directory exists
                                if (!fs.existsSync(tempDir)) {
                                    await mkdir(tempDir, { recursive: true });
                                }

                                const tempVideoPath = path.join(tempDir, `video_${tempId}${path.extname(req.file.originalname)}`);
                                const tempThumbPath = path.join(tempDir, `thumb_${tempId}.webp`);

                                // 1. Save buffer to temp file
                                await writeFile(tempVideoPath, buffer);

                                // 2. Extract frame using ffmpeg
                                await new Promise((resolve, reject) => {
                                    ffmpeg(tempVideoPath)
                                        .screenshots({
                                            timestamps: ['1'], // Capture at 1 second
                                            filename: path.basename(tempThumbPath),
                                            folder: path.dirname(tempThumbPath),
                                            size: '1080x?' // Match project width
                                        })
                                        .on('end', resolve)
                                        .on('error', reject);
                                });

                                // 3. Process generated thumb with Sharp (optional, for webp/optimization)
                                if (fs.existsSync(tempThumbPath)) {
                                    const thumbBuffer = await sharp(tempThumbPath)
                                        .resize(400) // Small width for thumbnails
                                        .webp({ quality: 60 })
                                        .toBuffer();

                                    thumbnailPath = await uploadToR2(thumbBuffer, folderName, `thumb_${req.file.originalname}`, 'image/webp');
                                    req.file.thumbnailPath = thumbnailPath;
                                    console.log('✅ Thumbnail generated successfully:', thumbnailPath);
                                }

                                // 4. Cleanup
                                if (fs.existsSync(tempVideoPath)) await unlink(tempVideoPath);
                                if (fs.existsSync(tempThumbPath)) await unlink(tempThumbPath);
                            } catch (thumbError) {
                                console.error('⚠️ Thumbnail generation failed, but video upload succeeded:', thumbError);
                                // Don't fail the whole request if only thumbnail fails
                            }
                        } else {
                            // Handle other file types (PDF, Doc, etc.)
                            console.log(`📄 Uploading non-media file: ${req.file.originalname} (${mimetype})`);
                            req.file.path = await uploadToR2(buffer, folderName, req.file.originalname, mimetype);
                        }

                        next();
                    } catch (error) {
                        console.error('Processing/Upload error:', error);
                        res.status(500).json({ error: error.message });
                    }
                });
            };
        },
        // Add array, fields, etc. if ever used in the project
        array: (fieldName, maxCount) => multerInstance.array(fieldName, maxCount),
        fields: (fields) => multerInstance.fields(fields)
    };
};

// Exported interfaces that match the project's usage
const upload = createMulterR2Interface({
    folder: 'short_news_images',
    width: 1080,
    height: 900,
    resize: true
});

const uploadMedia = createMulterR2Interface({
    folder: 'short_news_images', // Will auto-switch for videos in logic above
    width: 1080,
    height: 900,
    resize: true,
    limitSize: 50 * 1024 * 1024
});

const uploadAdMedia = createMulterR2Interface({
    folder: 'short_news_ads',
    resize: false, // Optimization only
    limitSize: 50 * 1024 * 1024
});

const uploadCategoryMedia = createMulterR2Interface({
    folder: 'short_news_categories',
    width: 500,
    height: 500,
    resize: true
});

module.exports = {
    upload,
    uploadMedia,
    uploadAdMedia,
    uploadCategoryMedia
};
