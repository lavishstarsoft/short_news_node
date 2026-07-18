const mongoose = require('mongoose');

const homeCardSchema = new mongoose.Schema(
  {
    number: { type: String, default: '1' },
    title: { type: String, default: '' },
    subtitle: { type: String, default: '' },
    cta: { type: String, default: '' },
    href: { type: String, default: '/post' },
    imageUrl: { type: String, default: '' }
  },
  { _id: false }
);

/**
 * Home page content — one document per language code
 * (uses same language codes as Language registry: te, hi, en, …)
 */
const reporterHomeContentSchema = new mongoose.Schema(
  {
    language: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
    },
    title: {
      type: String,
      default: 'ShortNews'
    },
    titleHighlight: {
      type: String,
      default: 'Reporter'
    },
    message: {
      type: String,
      default: ''
    },
    card1: {
      type: homeCardSchema,
      default: () => ({})
    },
    card2: {
      type: homeCardSchema,
      default: () => ({})
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('ReporterHomeContent', reporterHomeContentSchema);
