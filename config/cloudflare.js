const { S3Client } = require('@aws-sdk/client-s3');
require('dotenv').config();

const endpoint = process.env.CLOUDFLARE_R2_ENDPOINT || `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`;

const s3Client = new S3Client({
    region: 'auto',
    endpoint: endpoint,
    credentials: {
        accessKeyId: process.env.CLOUDFLARE_ACCESS_KEY_ID,
        secretAccessKey: process.env.CLOUDFLARE_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
});

const deleteFromR2 = async (url) => {
    if (!url) return;
    try {
        // Extract key from URL
        // URL format: https://pub-id.r2.dev/folder/filename.ext
        const urlObj = new URL(url);
        // Pathname usually includes the leading slash, remove it for the S3 Key
        const key = urlObj.pathname.startsWith('/') ? urlObj.pathname.substring(1) : urlObj.pathname;

        const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
        await s3Client.send(new DeleteObjectCommand({
            Bucket: process.env.CLOUDFLARE_R2_BUCKET_NAME,
            Key: key,
        }));
        console.log(`Successfully deleted from R2: ${key}`);
    } catch (error) {
        console.error(`Error deleting from R2: ${url}`, error);
    }
};

module.exports = {
    s3Client,
    bucketName: process.env.CLOUDFLARE_R2_BUCKET_NAME,
    publicUrl: process.env.CLOUDFLARE_R2_PUBLIC_URL,
    deleteFromR2
};
