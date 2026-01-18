const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema({
  newsId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'News'
  },
  viralVideoId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ViralVideo'
  },
  contentType: {
    type: String,
    enum: ['news', 'viral_video'],
    default: 'news'
  },
  userId: {
    type: String,
    required: true
  },
  userName: {
    type: String,
    required: true
  },
  userEmail: {
    type: String
  },
  mobileNumber: {
    type: String
  },
  reason: {
    type: String,
    required: true,
    enum: [
      // Web dashboard reasons
      'Inappropriate Content',
      'Spam',
      'Misleading Information',
      'Harassment',
      'Violence',
      'Hate Speech',
      'Copyright Violation',
      'Other',
      // Flutter app reasons
      'Mistakes observed',
      'Wrong content',
      'Hateful statements',
      'Biased story',
      'Copyright violation'
    ]
  },
  description: {
    type: String
  },
  status: {
    type: String,
    enum: ['pending', 'reviewed', 'resolved', 'dismissed'],
    default: 'pending'
  },
  reviewedAt: {
    type: Date
  },
  reviewedBy: {
    type: String
  }
}, {
  timestamps: true
});

// Add indexes for better performance
reportSchema.index({ newsId: 1 });
reportSchema.index({ viralVideoId: 1 });
reportSchema.index({ contentType: 1 });
reportSchema.index({ userId: 1 });
reportSchema.index({ status: 1 });
reportSchema.index({ createdAt: -1 });
reportSchema.index({ mobileNumber: 1 }); // Add index for mobile number

module.exports = mongoose.model('Report', reportSchema);