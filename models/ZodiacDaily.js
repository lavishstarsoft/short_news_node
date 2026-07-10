const mongoose = require('mongoose');

const zodiacDailySchema = new mongoose.Schema({
  date: {
    type: String, // Format: YYYY-MM-DD
    required: true,
    index: true
  },
  language: {
    type: String, // e.g., 'te', 'en', 'hi'
    required: true,
    index: true
  },
  chooseTitle: { 
    type: String, 
    required: true, 
    default: 'Choose your zodiac' 
  },
  knowTitle: { 
    type: String, 
    required: true, 
    default: 'Know your zodiac' 
  },
  resultTitleFormat: {
    type: String,
    required: true,
    default: '{sign} Horoscope ({date})'
  },
  signs: [{
    signId: { type: String, required: true }, // e.g., 'aries', 'taurus'
    name: { type: String, required: true }, // e.g., 'మేషం'
    result: { type: String, required: true }
  }],

  // Interaction Counters
  likes: { type: Number, default: 0 },
  dislikes: { type: Number, default: 0 },
  views: { type: Number, default: 0 },
  comments: { type: Number, default: 0 },

  // User Interactions Details
  userInteractions: {
    likes: [{
      userId: { type: String, required: true },
      userName: { type: String, required: true },
      timestamp: { type: Date, default: Date.now }
    }],
    dislikes: [{
      userId: { type: String, required: true },
      userName: { type: String, required: true },
      timestamp: { type: Date, default: Date.now }
    }],
    comments: [{
      userId: { type: String, required: true },
      userName: { type: String, required: true },
      comment: { type: String, required: true },
      timestamp: { type: Date, default: Date.now }
    }]
  },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Ensure only one entry per date per language
zodiacDailySchema.index({ date: 1, language: 1 }, { unique: true });

zodiacDailySchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('ZodiacDaily', zodiacDailySchema);
