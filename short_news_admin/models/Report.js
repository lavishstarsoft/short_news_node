const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema({
  newsId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'News', 
    required: true 
  },
  userId: { 
    type: String, 
    required: true 
  },
  userEmail: { 
    type: String 
  },
  userName: { 
    type: String 
  },
  reason: { 
    type: String, 
    required: true 
  },
  description: { 
    type: String 
  },
  mobileNumber: { 
    type: String 
  },
  status: { 
    type: String, 
    enum: ['pending', 'reviewed', 'resolved', 'dismissed'], 
    default: 'pending' 
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  reviewedAt: { 
    type: Date 
  },
  reviewedBy: { 
    type: String 
  }
});

// Add indexes for better performance
reportSchema.index({ newsId: 1 });
reportSchema.index({ userId: 1 });
reportSchema.index({ status: 1 });
reportSchema.index({ createdAt: -1 });
reportSchema.index({ mobileNumber: 1 }); // Add index for mobile number

module.exports = mongoose.model('Report', reportSchema);