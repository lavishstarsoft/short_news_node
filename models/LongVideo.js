const mongoose = require('mongoose');

const longVideoSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String },
  videoUrl: { type: String, required: true }, // YouTube URL or Direct MP4 URL
  thumbnailUrl: { type: String }, // YouTube Thumbnail or Custom Thumbnail
  category: { type: String, required: true }, // e.g., "News Bulletin", "Folk Songs"
  publishedAt: { type: Date, default: Date.now },
  views: { type: Number, default: 0 },
  likes: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  
  // Interactions for future use
  userInteractions: {
    likes: [{
      userId: { type: String, required: true },
      userName: { type: String, required: true },
      timestamp: { type: Date, default: Date.now }
    }],
    views: [{
      userId: { type: String, required: true },
      timestamp: { type: Date, default: Date.now }
    }]
  }
});

// Index for the active long-video feed
longVideoSchema.index({ isActive: 1 });

module.exports = mongoose.model('LongVideo', longVideoSchema);
