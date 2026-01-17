const mongoose = require('mongoose');

const viralVideoSchema = new mongoose.Schema({
    title: { type: String, required: true },
    content: { type: String, required: false },
    videoUrl: { type: String }, // External video URL (YouTube, Instagram, Vimeo, etc.)
    mediaUrl: { type: String }, // Uploaded video file path
    thumbnailUrl: { type: String }, // Video thumbnail
    category: { type: String, required: true },
    publishedAt: { type: Date, default: Date.now },
    views: { type: Number, default: 0 },
    likes: { type: Number, default: 0 },
    dislikes: { type: Number, default: 0 },
    comments: { type: Number, default: 0 },
    author: { type: String, required: true },
    authorId: { type: String, required: true },
    isActive: { type: Boolean, default: true },

    // User interactions
    userInteractions: {
        likes: [{
            userId: { type: String, required: true },
            userName: { type: String, required: true },
            userEmail: { type: String },
            timestamp: { type: Date, default: Date.now }
        }],
        dislikes: [{
            userId: { type: String, required: true },
            userName: { type: String, required: true },
            userEmail: { type: String },
            timestamp: { type: Date, default: Date.now }
        }],
        comments: [{
            userId: { type: String, required: true },
            userName: { type: String, required: true },
            userEmail: { type: String },
            comment: { type: String, required: true },
            timestamp: { type: Date, default: Date.now },
            likes: [{
                userId: { type: String, required: true },
                userName: { type: String, required: true },
                timestamp: { type: Date, default: Date.now }
            }]
        }]
    }
}, { timestamps: true }); // Add createdAt and updatedAt automatically

module.exports = mongoose.model('ViralVideo', viralVideoSchema);
