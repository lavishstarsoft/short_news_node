const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  googleId: { type: String, unique: true, required: true }, // Make Google ID required
  displayName: { type: String, required: true },
  email: { type: String, unique: true, required: true }, // Make email required for Google users
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