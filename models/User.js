const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  googleId: { type: String, sparse: true, unique: true }, // Make optional but unique if provided
  email: { type: String, sparse: true, unique: true }, // Optional email
  mobileNumber: { type: String, sparse: true, unique: true }, // Optional mobile
  displayName: { type: String, required: true },
  photoUrl: { type: String },
  createdAt: { type: Date, default: Date.now },
  lastLogin: { type: Date, default: Date.now },
  // Add any additional fields you might want to track
  interactions: {
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'News' }],
    dislikes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'News' }],
    comments: [{ 
      newsId: { type: mongoose.Schema.Types.ObjectId, ref: 'News' },
      comment: String,
      timestamp: { type: Date, default: Date.now }
    }]
  }
});

// Add indexes for better performance
userSchema.index({ googleId: 1 });
userSchema.index({ email: 1 });

module.exports = mongoose.model('User', userSchema);