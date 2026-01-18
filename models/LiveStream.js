const mongoose = require('mongoose');

const liveStreamSchema = new mongoose.Schema({
    isLive: {
        type: Boolean,
        default: false
    },
    url: {
        type: String,
        default: ''
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

// We only need one document for global config, but standard collection usage is fine.
// We'll generally fetch/update the first document.

module.exports = mongoose.model('LiveStream', liveStreamSchema);
