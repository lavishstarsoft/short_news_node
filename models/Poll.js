const mongoose = require('mongoose');

const optionSchema = new mongoose.Schema({
  text: { 
    type: String, 
    required: true,
    trim: true
  },
  votes: { 
    type: Number, 
    default: 0 
  }
});

const pollSchema = new mongoose.Schema({
  question: { 
    type: String, 
    required: true,
    trim: true,
    maxlength: 500
  },
  language: {
    type: String,
    default: 'te',
    required: true
  },
  options: [optionSchema],
  totalVotes: { 
    type: Number, 
    default: 0 
  },
  votedUsers: [{
    userId: { 
      type: String, 
      required: true 
    },
    optionId: { 
      type: mongoose.Schema.Types.ObjectId, 
      required: true 
    }
  }],
  isActive: { 
    type: Boolean, 
    default: true 
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  updatedAt: { 
    type: Date, 
    default: Date.now 
  }
});

pollSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Poll', pollSchema);
