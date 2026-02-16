const multer = require('multer');
const sharp = require('sharp');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { s3Client, bucketName, publicUrl } = require('../config/cloudflare');
const path = require('path');
const crypto = require('crypto');

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

                        // Image processing with Sharp
                        if (mimetype.startsWith('image/')) {
                            let sharpInstance = sharp(buffer);
                            if (resize && width && height) {
                                sharpInstance = sharpInstance.resize(width, height, { fit: 'cover' });
                            }
                            buffer = await sharpInstance.webp({ quality: 80 }).toBuffer();
                            mimetype = 'image/webp';
                        } else if (mimetype.startsWith('video/')) {
                            // Automatically switch to video folder if it's a video and we were in images
                            folderName = folder === 'short_news_images' ? 'short_news_videos' : folder;
                        }

                        req.file.path = await uploadToR2(buffer, folderName, req.file.originalname, mimetype);
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
    height: 1560,
    resize: true
});

const uploadMedia = createMulterR2Interface({
    folder: 'short_news_images', // Will auto-switch for videos in logic above
    width: 1080,
    height: 1560,
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
