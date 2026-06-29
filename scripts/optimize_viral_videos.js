/**
 * Batch re-encodes all existing viral videos with -movflags faststart for instant streaming.
 * This is the KEY fix for Instagram-like fast loading.
 * Run: node scripts/optimize_viral_videos.js
 */

const mongoose = require('mongoose');
const path = require('path');
const os = require('os');
const fs = require('fs');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { mkdir, unlink, writeFile } = require('fs/promises');
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3Client, bucketName, publicUrl, deleteFromR2 } = require('../config/cloudflare');
require('dotenv').config();

// Set ffmpeg paths (same as upload.js)
const ffmpegPaths = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
const ffprobePaths = ['/usr/bin/ffprobe', '/usr/local/bin/ffprobe'];
for (const p of ffmpegPaths) { if (fs.existsSync(p)) { ffmpeg.setFfmpegPath(p); break; } }
for (const p of ffprobePaths) { if (fs.existsSync(p)) { ffmpeg.setFfprobePath(p); break; } }

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

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const proto = url.startsWith('https') ? https : http;
        const file = fs.createWriteStream(dest);
        proto.get(url, (res) => {
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
        }).on('error', (err) => {
            fs.unlink(dest, () => {});
            reject(err);
        });
    });
}

async function main() {
    await mongoose.connect(
        process.env.MONGODB_URI || 'mongodb+srv://admin:admin@cluster0.zox9u.mongodb.net/Shortnews?retryWrites=true&w=majority'
    );
    console.log('✅ Connected to MongoDB');

    // Process all videos that have a mediaUrl (re-encode all for faststart)
    const videos = await ViralVideo.find({
        mediaUrl: { $exists: true, $ne: null, $ne: '' },
        isActive: true
    }).select('_id title mediaUrl thumbnailUrl');

    console.log(`🎬 Found ${videos.length} videos to optimize`);

    const tempDir = path.join(os.tmpdir(), 'viral_optimize');
    if (!fs.existsSync(tempDir)) await mkdir(tempDir, { recursive: true });

    let success = 0;
    let failed = 0;

    for (let i = 0; i < videos.length; i++) {
        const video = videos[i];
        console.log(`\n[${i+1}/${videos.length}] ${video.title.substring(0, 50)}`);

        const id = crypto.randomBytes(6).toString('hex');
        const tempInput  = path.join(tempDir, `input_${id}.mp4`);
        const tempOutput = path.join(tempDir, `output_${id}.mp4`);
        const tempThumb  = path.join(tempDir, `thumb_${id}.jpg`);

        try {
            // 1. Download original
            console.log(`  ⬇️  Downloading...`);
            await downloadFile(video.mediaUrl, tempInput);
            const origSizeMB = (fs.statSync(tempInput).size / 1024 / 1024).toFixed(1);
            console.log(`  📦 Original size: ${origSizeMB} MB`);

            // 2. Re-encode with faststart + 720p
            console.log(`  ⚙️  Re-encoding with faststart...`);
            await new Promise((resolve, reject) => {
                ffmpeg(tempInput)
                    .videoCodec('libx264')
                    .audioCodec('aac')
                    .outputOptions([
                        '-movflags faststart',
                        '-crf 28',
                        '-preset fast',
                        "-vf scale='min(720,iw)':-2",
                        '-pix_fmt yuv420p',
                    ])
                    .on('end', resolve)
                    .on('error', reject)
                    .save(tempOutput);
            });

            const newSizeMB = (fs.statSync(tempOutput).size / 1024 / 1024).toFixed(1);
            console.log(`  ✅ New size: ${newSizeMB} MB (saved ${(origSizeMB - newSizeMB).toFixed(1)} MB)`);

            // 3. Upload optimized video
            const optimizedBuffer = fs.readFileSync(tempOutput);
            const newMediaUrl = await uploadBufferToR2(optimizedBuffer, 'short_news_videos', `opt_${id}.mp4`, 'video/mp4');

            // 4. Generate thumbnail if not already present
            let thumbnailUrl = video.thumbnailUrl;
            if (!thumbnailUrl) {
                try {
                    await new Promise((resolve, reject) => {
                        ffmpeg(tempOutput)
                            .screenshots({ timestamps: ['1'], filename: path.basename(tempThumb), folder: path.dirname(tempThumb), size: '720x?' })
                            .on('end', resolve)
                            .on('error', reject);
                    });
                    if (fs.existsSync(tempThumb)) {
                        const thumbBuf = await sharp(tempThumb).resize(600).webp({ quality: 70 }).toBuffer();
                        thumbnailUrl = await uploadBufferToR2(thumbBuf, 'short_news_videos', `thumb_${id}.webp`, 'image/webp');
                        console.log(`  🖼️  Thumbnail: ${thumbnailUrl}`);
                    }
                } catch (te) { console.warn('  ⚠️  Thumb failed:', te.message); }
            }

            // 5. Update DB with new URL
            const update = { mediaUrl: newMediaUrl };
            if (thumbnailUrl) update.thumbnailUrl = thumbnailUrl;
            await ViralVideo.findByIdAndUpdate(video._id, update);
            console.log(`  💾 DB updated → ${newMediaUrl}`);
            success++;

        } catch (err) {
            console.error(`  ❌ Failed: ${err.message}`);
            failed++;
        } finally {
            for (const f of [tempInput, tempOutput, tempThumb]) {
                try { if (fs.existsSync(f)) await unlink(f); } catch (_) {}
            }
        }
    }

    console.log(`\n🏁 Done! ✅ ${success} optimized, ❌ ${failed} failed`);
    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
