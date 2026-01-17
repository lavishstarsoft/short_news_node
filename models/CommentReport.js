const mongoose = require('mongoose');

const commentReportSchema = new mongoose.Schema({
    newsId: {
        type: String,
        required: true,
        index: true
    },
    commentText: {
        type: String,
        required: true
    },
    commentUserId: {
        type: String,
        required: true
    },
    commentUserName: {
        type: String,
        required: true
    },
    reportedBy: {
        userId: { type: String, required: true },
        userName: { type: String, required: true },
        userEmail: { type: String }
    },
    reason: {
        type: String,
        required: true,
        enum: ['biased', 'abusive', 'hateful', 'fake', 'spam', 'others']
    },
    additionalDetails: {
        type: String,
        default: ''
    },
    status: {
        type: String,
        default: 'pending',
        enum: ['pending', 'reviewed', 'removed', 'ignored']
    },
    createdAt: {
        type: Date,
        default: Date.now,
        index: true
    },
    reviewedAt: {
        type: Date
    },
    reviewedBy: {
        adminId: { type: String },
        adminName: { type: String }
    }
});

// Index for faster queries
commentReportSchema.index({ status: 1, createdAt: -1 });
commentReportSchema.index({ newsId: 1, commentText: 1 });

module.exports = mongoose.model('CommentReport', commentReportSchema);
