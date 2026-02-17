const mongoose = require('mongoose');

const newsSchema = new mongoose.Schema({
  title: { type: String, required: true, maxlength: 100 },
  content: { type: String, required: true, maxlength: 1000 },
  imageUrl: { type: String }, // Keep for backward compatibility
  mediaUrl: { type: String }, // New field for both images and videos
  mediaType: { type: String, enum: ['image', 'video'] }, // New field to specify media type
  thumbnailUrl: { type: String }, // New field for video thumbnails
  category: { type: String, required: true },
  location: { type: String },
  publishedAt: { type: Date, default: Date.now },
  likes: { type: Number, default: 0 },
  dislikes: { type: Number, default: 0 },
  views: { type: Number, default: 0 }, // Add views field
  comments: { type: Number, default: 0 },
  author: { type: String, required: true },
  authorId: { type: String, required: true }, // Add authorId to track the editor
  isActive: { type: Boolean, default: true }, // Add active status field
  isRead: { type: Boolean, default: false }, // Add read status field
  readFullLink: { type: String }, // Custom link for "Read Full Article" button
  ePaperLink: { type: String }, // Custom link for "ePaper" button
  videoUrl: { type: String }, // External video URL (YouTube, Instagram, Vimeo, etc.)
  shortId: { type: String, unique: true }, // Short ID for Fact Check (cbnys.co/XXXXXX)

  // New fields for storing user interaction details
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
    }],
    views: [{
      userId: { type: String, required: true },
      userName: { type: String, required: true },
      userEmail: { type: String },
      timestamp: { type: Date, default: Date.now }
    }]
  }
});

// Pre-save hook to generate shortId if not provided
newsSchema.pre('save', function (next) {
  if (!this.shortId) {
    const idStr = this._id.toString();
    this.shortId = idStr.length > 6 ? idStr.substring(idStr.length - 6) : idStr;
  }
  next();
});

module.exports = mongoose.model('News', newsSchema);