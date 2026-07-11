const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  googleId: { type: String, sparse: true, unique: true }, // Make optional but unique if provided
  email: { type: String, sparse: true, unique: true }, // Optional email
  mobileNumber: { type: String, sparse: true, unique: true }, // Optional mobile
  displayName: { type: String, required: true },
  photoUrl: { type: String },
  createdAt: { type: Date, default: Date.now },
  lastLogin: { type: Date, default: Date.now },
  locationProfile: {
    primaryState: { type: String, default: null },
    primaryDistrict: { type: String, default: null },
    coordinates: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null }
    },
    source: {
      type: String,
      enum: ['gps', 'manual', 'inferred'],
      default: null
    },
    additionalLocations: [{ type: String }],
    updatedAt: { type: Date, default: null }
  },
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