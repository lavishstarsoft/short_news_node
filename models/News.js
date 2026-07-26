const mongoose = require('mongoose');

const newsSchema = new mongoose.Schema({
  title: { type: String, required: true, maxlength: 62 },
  content: { type: String, required: true, maxlength: 500 },
  imageUrl: { type: String }, // Keep for backward compatibility
  imageUrls: { type: [String], default: [] }, // Array of image URLs for photo carousel
  mediaUrl: { type: String }, // New field for both images and videos
  mediaType: { type: String, enum: ['image', 'video'] }, // New field to specify media type
  thumbnailUrl: { type: String }, // New field for video thumbnails
  sourceLink: { type: String }, // New field for source link assigned by super admin
  category: { type: String, required: true },
  location: { type: String },
  scope: {
    type: String,
    enum: ['district', 'state', 'national', 'international'],
    default: 'state'
  },
  language: {
    type: String,
    default: 'te',
    index: true
  },
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
  authorProfileImage: { type: String }, // Denormalized for performance
  authorConstituency: { type: String }, // Denormalized for performance
  shortId: { type: String, unique: true }, // Short ID for Fact Check (cbnys.co/XXXXXX)
  contentHash: { type: String, index: true }, // Hash for duplicate detection
  /** Client-supplied key to prevent double-create from retries / double-tap (reporter app). */
  clientIdempotencyKey: { type: String },
  /** Background media fingerprints for ANN / perceptual duplicate (Node-owned). */
  mediaFingerprint: {
    status: { type: String, enum: ['pending', 'ready', 'failed'], default: undefined },
    sha256: { type: String },
    phash: { type: String },
    dhash: { type: String },
    clipEmbedding: { type: [Number], default: undefined },
    clipEmbeddingVersion: { type: String },
    modelId: { type: String },
    dimensions: { type: Number },
    mediaUrl: { type: String },
    indexed: { type: Boolean, default: false },
    lastError: { type: String },
    computedAt: { type: Date },
  },
  duplicateCheck: {
    isDuplicate: { type: Boolean, default: false },
    isSuspicious: { type: Boolean, default: false },
    score: { type: Number, default: 0 },
    matchCount: { type: Number, default: 0 },
    checkedAt: { type: Date },
    /** Set when AI media cascade hashed the query image (sha/phash). */
    mediaPassAt: { type: Date },
    /** content | image | both — why duplicate was flagged */
    matchSource: { type: String },
    reasonLabel: { type: String },
    reasonMessage: { type: String },
    similarArticles: { type: mongoose.Schema.Types.Mixed, default: [] }
  },

  // AI verification workflow status (Sub Editor async publish gate)
  aiStatus: {
    type: String,
    enum: ['none', 'processing', 'verified', 'review_required', 'failed'],
    default: 'none',
  },
  aiVerifiedAt: { type: Date },

  // Rejection Details
  rejectionStatus: {
    isRejected: { type: Boolean, default: false },
    reason: { type: String }, // Predefined reason (e.g., "Plagiarism", "Poor Quality")
    feedback: { type: String }, // Custom feedback from editor
    rejectedBy: { type: String }, // Editor name who rejected
    rejectedByRole: { type: String }, // Role: Admin, Sub Editor, Reporter
    rejectedAt: { type: Date } // When was it rejected
  },

  // Approval Details
  approvalStatus: {
    isApproved: { type: Boolean, default: false },
    approvedBy: { type: String }, // Editor/Admin name who approved
    approvedByRole: { type: String }, // Role: Admin, Sub Editor, Reporter
    approvedAt: { type: Date } // When was it approved
  },

  /**
   * Needs Revision (Send Back for Edit).
   * Separate from rejectionStatus — reject remains final.
   */
  revisionStatus: {
    needsRevision: { type: Boolean, default: false },
    remarks: { type: String },
    sentBackBy: { type: String },
    sentBackById: { type: String },
    sentBackByRole: { type: String },
    sentAt: { type: Date },
    revisionCount: { type: Number, default: 0 },
    lastRevisionRound: { type: Number, default: 0 },
    lastResubmitRound: { type: Number, default: 0 },
    resubmittedAt: { type: Date },
    /** Frozen article fields at send-back time (before reporter edits). */
    revisionSnapshot: { type: mongoose.Schema.Types.Mixed },
    /** Structured diff computed on resubmit (before vs after). */
    lastChangeSummary: { type: mongoose.Schema.Types.Mixed },
  },

  // Timeline of editorial/admin actions for auditing
  actionHistory: [{
    action: {
      type: String,
      enum: [
        'created',
        'updated',
        'status_toggled',
        'approved',
        'rejected',
        'deleted',
        'needs_revision',
        'resubmitted',
      ],
      required: true
    },
    performedById: { type: String },
    performedByName: { type: String },
    performedByRole: { type: String },
    details: { type: String },
    metadata: { type: mongoose.Schema.Types.Mixed },
    performedAt: { type: Date, default: Date.now }
  }],

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

// Pre-save hook to generate shortId and contentHash if not provided
newsSchema.pre('save', function (next) {
  if (!this.shortId) {
    const idStr = this._id.toString();
    this.shortId = idStr.length > 6 ? idStr.substring(idStr.length - 6) : idStr;
  }

  // Generate content hash for duplicate detection
  if (!this.contentHash && (this.title || this.content)) {
    const crypto = require('crypto');
    const combined = `${this.title || ''}${this.content || ''}`.toLowerCase();
    this.contentHash = crypto.createHash('md5').update(combined).digest('hex');
  }

  next();
});

// Compound indexes for fast queries
newsSchema.index({ publishedAt: -1 }); // Default sorting for news list
newsSchema.index({ isActive: 1, 'rejectionStatus.isRejected': 1, publishedAt: -1 }); // Pending news page
newsSchema.index({
  isActive: 1,
  'rejectionStatus.isRejected': 1,
  'revisionStatus.needsRevision': 1,
  publishedAt: -1,
}); // Pending + Needs Revision filters
newsSchema.index({ authorId: 1, 'revisionStatus.needsRevision': 1, publishedAt: -1 });
newsSchema.index({ isActive: 1, publishedAt: -1 }); // Published news (duplicate check, feeds)
newsSchema.index({ language: 1, isActive: 1, publishedAt: -1 }); // Language-filtered feed
newsSchema.index({ category: 1, isActive: 1, publishedAt: -1 }); // Category feed
newsSchema.index({ location: 1, isActive: 1, publishedAt: -1 }); // Location feed
newsSchema.index({ scope: 1, location: 1, language: 1, isActive: 1, publishedAt: -1 }); // Smart feed
newsSchema.index({ authorId: 1, publishedAt: -1 }); // Reporter's own news list
newsSchema.index({ aiStatus: 1, isActive: 1, publishedAt: -1 }); // AI verification queue
// One create per reporter + Idempotency-Key (partial so older docs without key are fine)
newsSchema.index(
  { authorId: 1, clientIdempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      clientIdempotencyKey: { $exists: true, $type: 'string', $gt: '' },
    },
  }
);

module.exports = mongoose.model('News', newsSchema);