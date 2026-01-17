const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');

// Image upload storage configuration
const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'short_news_images',
        allowed_formats: ['jpg', 'png', 'jpeg', 'webp'],
        transformation: [
            { width: 1080, height: 1560, crop: 'fill', gravity: 'auto' }, // 9:13 aspect ratio
            { quality: 'auto', fetch_format: 'auto' } // Optimization
        ]
    }
});

// Category-specific media storage (Square crop for circular icons)
const categoryMediaStorageConfig = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'short_news_categories',
        resource_type: 'image',
        allowed_formats: ['jpg', 'png', 'jpeg', 'webp'],
        transformation: [
            { width: 500, height: 500, crop: 'fill', gravity: 'auto' }, // 1:1 Square aspect ratio
            { quality: 'auto', fetch_format: 'auto' }
        ]
    }
});

// Video upload storage configuration
const videoStorage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'short_news_videos',
        resource_type: 'video',
        allowed_formats: ['mp4', 'mov', 'avi', 'mkv'],
    }
});

// General media storage (can handle both conceptually, but CloudinaryStorage params are specific)
// We'll create a smart middleware that decides based on file type if possible, 
// OR we just declare two separate multer instances.
// Since CloudinaryStorage forces resource_type in params (default image), 
// we likely need separate uploaders or a hybrid approach if using the same route.
// However, the CloudinaryStorage `params` can be a function.

const mediaStorageConfig = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: async (req, file) => {
        if (file.mimetype.startsWith('video/')) {
            return {
                folder: 'short_news_videos',
                resource_type: 'video',
                allowed_formats: ['mp4', 'mov', 'avi', 'mkv'],
                // NO synchronous transformation - upload raw video first
                // All transformations happen in background to avoid timeout
                eager: [
                    { width: 480, crop: 'limit', video_codec: 'h264', quality: 'auto:low', format: 'mp4' },   // 480p
                    { width: 720, crop: 'limit', video_codec: 'h264', quality: 'auto:good', format: 'mp4' },  // 720p
                ],
                eager_async: true,  // Generate in background (prevents 502 timeout)
                format: 'mp4'       // Standard MP4 format
            };
        } else {
            return {
                folder: 'short_news_images',
                resource_type: 'image',
                allowed_formats: ['jpg', 'png', 'jpeg', 'webp'],
                transformation: [
                    { width: 1080, height: 1560, crop: 'fill', gravity: 'auto' },
                    { quality: 'auto', fetch_format: 'auto' }
                ]
            };
        }
    }
});


// Middleware for single image upload
const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// Middleware for media upload (image or video)
const uploadMedia = multer({
    storage: mediaStorageConfig,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB (increased for videos)
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image and video files are allowed!'), false);
        }
    }
});

// Ad-specific media storage (NO transformation - preserves exact crop from admin)
const adMediaStorageConfig = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: async (req, file) => {
        if (file.mimetype.startsWith('video/')) {
            return {
                folder: 'short_news_ads',
                resource_type: 'video',
                allowed_formats: ['mp4', 'mov', 'avi', 'mkv']
            };
        } else {
            return {
                folder: 'short_news_ads',
                resource_type: 'image',
                allowed_formats: ['jpg', 'png', 'jpeg', 'webp'],
                // NO transformation - preserves exact crop from admin (9:16 ratio)
                transformation: [
                    { quality: 'auto', fetch_format: 'auto' } // Only optimization, no resizing
                ]
            };
        }
    }
});

// Middleware for ad media upload (preserves exact dimensions from admin crop)
const uploadAdMedia = multer({
    storage: adMediaStorageConfig,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image and video files are allowed!'), false);
        }
    }
});


// Middleware for category media upload (enforces square crop)
const uploadCategoryMedia = multer({
    storage: categoryMediaStorageConfig,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed for categories!'), false);
        }
    }
});

module.exports = {
    upload,
    uploadMedia,
    uploadAdMedia,
    uploadCategoryMedia // New: For categories - square crop
};
