const mongoose = require('mongoose');

/**
 * Reporter Hub — the screen the MAIN Flutter app opens when a user taps "+"
 * (Way2News-style "Be a reporter" hub). One document per language code, fully
 * admin-editable, served to the app by GET /api/public/reporter-hub?lang=xx.
 *
 * ADDITIVE + SAFE: `enabled` defaults to false, so nothing shows in the
 * production app until an admin turns a language on. The app falls back to
 * English, then to built-in defaults, so it never renders blank.
 */
// A card is now a single full portrait image (admin-designed, cropped 3:5).
const cardSchema = new mongoose.Schema(
  {
    order: { type: Number, default: 1 },
    key: { type: String, default: '' }, // reporter | advertise | custom
    action: { type: String, default: 'register' }, // register | login | url | whatsapp | none
    actionValue: { type: String, default: '' }, // URL / WhatsApp number for url|whatsapp
    imageUrl: { type: String, default: '' }, // the full card image
  },
  { _id: false }
);

const faqItemSchema = new mongoose.Schema(
  {
    order: { type: Number, default: 1 },
    q: { type: String, default: '' },
    a: { type: String, default: '' },
    icon: { type: String, default: 'help' }, // help | doc | video | rupee | info
  },
  { _id: false }
);

const reporterHubContentSchema = new mongoose.Schema(
  {
    language: { type: String, required: true, unique: true, lowercase: true, trim: true },
    enabled: { type: Boolean, default: false }, // feature flag per language (default OFF)

    // NOTE: the header (Welcome / Guest / login hint) is no longer stored or
    // admin-editable. The app shows it dynamically: "Guest" when logged out,
    // and the reporter's own name once logged in (future login).

    // Banner is now a single admin-designed image (cropped to the recommended
    // size). Tapping it in the app opens reporter registration.
    banner: {
      imageUrl: { type: String, default: '' },
    },


    cards: { type: [cardSchema], default: [] },

    faq: {
      title: { type: String, default: '' },
      subtitle: { type: String, default: '' },
      seeAll: { type: String, default: '' },
      items: { type: [faqItemSchema], default: [] },
    },

    nav: {
      dashboard: { type: String, default: '' },
      myStories: { type: String, default: '' },
      myDistrict: { type: String, default: '' },
      appDetails: { type: String, default: '' },
    },

    updatedBy: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.models.ReporterHubContent || mongoose.model('ReporterHubContent', reporterHubContentSchema);
