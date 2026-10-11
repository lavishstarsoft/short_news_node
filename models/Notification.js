const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: false
  },
  type: {
    type: String,
    enum: ['news', 'admin', 'system'],
    default: 'admin'
  },
  priority: {
    type: String,
    enum: ['normal', 'high', 'urgent'],
    default: 'normal'
  },
  newsId: {
    type: String,
    default: null
  },
  imageUrl: {
    type: String,
    default: null
  },
  recipients: [{
    userId: String,
    received: {
      type: Boolean,
      default: false
    },
    receivedAt: {
      type: Date,
      default: null
    },
    opened: {
      type: Boolean,
      default: false
    },
    openedAt: {
      type: Date,
      default: null
    }
  }],
  sentBy: {
    type: String,
    required: true
  },
  sentAt: {
    type: Date,
    default: Date.now
  }
});

// Add indexes for better query performance
notificationSchema.index({ sentAt: -1 });
notificationSchema.index({ type: 1 });
notificationSchema.index({ priority: 1 });
notificationSchema.index({ "recipients.userId": 1 });
// Every delivered news triggers a `news_received` ack per user, each of which
// looks up notifications by newsId. Without this index that was a full
// collection scan per ack — the main cause of CPU spikes at posting peaks.
notificationSchema.index({ newsId: 1 });

module.exports = mongoose.model('Notification', notificationSchema);