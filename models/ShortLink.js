const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

const ShortLinkSchema = new mongoose.Schema({
    shortCode: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    // Exactly one target: a news article OR a poll (see pre-validate below).
    newsId: {
        type: String,
        required: false
    },
    pollId: {
        type: String,
        required: false,
        index: true
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: '365d' // Optional: Links expire after 1 year to save space
    },
    clicks: {
        type: Number,
        default: 0
    }
});

// A short link must point at something.
ShortLinkSchema.pre('validate', function (next) {
    if (!this.newsId && !this.pollId) return next(new Error('newsId or pollId is required'));
    next();
});

// Generate a random 6-character short code if none is provided
ShortLinkSchema.pre('validate', function (next) {
    if (!this.shortCode) {
        // Generate a secure random string and take the first 6 characters
        // E.g., a8f3b2
        this.shortCode = uuidv4().replace(/-/g, '').substring(0, 6);
    }
    next();
});

const ShortLink = mongoose.model('ShortLink', ShortLinkSchema);

module.exports = ShortLink;
