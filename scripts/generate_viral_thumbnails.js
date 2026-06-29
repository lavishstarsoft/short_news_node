const mongoose = require('mongoose');
const path = require('path');
const os = require('os');
const fs = require('fs');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { mkdir, unlink } = require('fs/promises');
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3Client, bucketName, publicUrl } = require('../config/cloudflare');
require('dotenv').config();

const ViralVideo = require('../models/ViralVideo');

async function uploadBufferToR2(buffer, folder, filename, mimetype) {
    const key = `${folder}/${filename}`;
    await s3Client.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: buffer,
        ContentType: mimetype,
    }));
    return `${publicUrl}/${key}`;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const proto = url.startsWith('https') ? https : http;
        const file = fs.createWriteStream(dest);
        proto.get(url, (res) => {
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
        }).on('error', (err) => {
            fs.unlink(dest, () => {});
            reject(err);
        });
    });
}

function extractFrame(videoPath, thumbPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .screenshots({
                timestamps: ['1'],
                filename: path.basename(thumbPath),
                folder: path.dirname(thumbPath),
                size: '1080x?'
            })
            .on('end', resolve)
            .on('error', reject);
    });
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
    await mongoose.connect(
        process.env.MONGODB_URI || 'mongodb+srv://admin:admin@cluster0.zox9u.mongodb.net/Shortnews?retryWrites=true&w=majority'
    );
    console.log('✅ Connected to MongoDB');

    // Find videos without thumbnailUrl
    const videos = await ViralVideo.find({
        $or: [{ thumbnailUrl: null }, { thumbnailUrl: '' }, { thumbnailUrl: { $exists: false } }],
        mediaUrl: { $exists: true, $ne: null, $ne: '' }
    }).select('_id title mediaUrl');

    console.log(`🎬 Found ${videos.length} videos without thumbnails`);

    const tempDir = path.join(os.tmpdir(), 'viral_thumbs');
    if (!fs.existsSync(tempDir)) await mkdir(tempDir, { recursive: true });

    let success = 0;
    let failed = 0;

    for (const video of videos) {
        const id = crypto.randomBytes(6).toString('hex');
        const tempVideo = path.join(tempDir, `video_${id}.mp4`);
        const tempThumb = path.join(tempDir, `thumb_${id}.jpg`);
        const tempThumbWebp = path.join(tempDir, `thumb_${id}.webp`);

        try {
            console.log(`⬇️  Downloading: ${video.title.substring(0, 50)}`);
            await downloadFile(video.mediaUrl, tempVideo);

            console.log(`🖼️  Extracting frame...`);
            await extractFrame(tempVideo, tempThumb);

            if (!fs.existsSync(tempThumb)) {
                console.warn(`⚠️  Frame extraction produced no output for ${video._id}`);
                failed++;
                continue;
            }

            // Optimize with sharp → webp
            const thumbBuffer = await sharp(tempThumb)
                .resize(600)
                .webp({ quality: 70 })
                .toBuffer();

            // Upload to R2
            const folder = 'short_news_videos';
            const thumbnailUrl = await uploadBufferToR2(thumbBuffer, folder, `thumb_${id}.webp`, 'image/webp');

            // Save to DB
            await ViralVideo.findByIdAndUpdate(video._id, { thumbnailUrl });
            console.log(`✅ Saved thumbnail for "${video.title.substring(0, 40)}" → ${thumbnailUrl}`);
            success++;

        } catch (err) {
            console.error(`❌ Failed for ${video._id}:`, err.message);
            failed++;
        } finally {
            // Cleanup
            for (const f of [tempVideo, tempThumb, tempThumbWebp]) {
                try { if (fs.existsSync(f)) await unlink(f); } catch (_) {}
            }
        }
    }

    console.log(`\n🏁 Done! ✅ ${success} succeeded, ❌ ${failed} failed`);
    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
