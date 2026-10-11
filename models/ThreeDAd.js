'use strict';

const mongoose = require('mongoose');

// A dashboard-managed 3D (CSS-rotated) image ad. Any uploaded image becomes an
// auto-rotating banner the app shows at the bottom of roomy news cards; tapping
// it opens an in-app page (quiz/train/games/viral), an external URL, or a news
// item. Fully additive + isolated — nothing here touches the existing Ad model.
const threeDAdSchema = new mongoose.Schema({
  title: { type: String, required: true },          // internal label
  imageUrl: { type: String, required: true },       // the source image
  // Optional embossed 3D model baked from imageUrl (free, on-CPU). When set, the
  // app renders this real .glb (model-viewer); otherwise it CSS-rotates the flat
  // image. Lets the owner pick per-ad: cheap flat spin OR a raised 3D relief.
  glbUrl: { type: String, default: '' },

  // Up to 4 images for the dice/cube rotate style — one per side (front, right,
  // back, left). Empty slots fall back to the Tehelka logo in the preview/app,
  // so no side is ever blank. Additive; other rotate styles ignore this.
  cubeImages: { type: [String], default: [] },

  // "Floating mascot" style: an animated character (Lottie .json or image) that
  // walks/bobs along the card bottom, with an optional small banner. Additive;
  // other styles ignore these.
  mascotUrl: { type: String, default: '' },   // Lottie .json URL or image URL
  bannerText: { type: String, default: '' },  // optional speech-bubble text

  // Plain-image style extras (the cube ignores all of these). Additive —
  // existing static ads keep today's look: bottom-right, image, default size.
  plainPosition: {
    type: String,
    enum: ['top_left', 'top_center', 'top_right', 'center_left', 'center', 'center_right',
      'bottom_left', 'bottom_center', 'bottom_right', 'below_body'],
    default: 'bottom_right',
  },
  plainOffsetX: { type: Number, default: 0, min: -300, max: 300 }, // px nudge (+ right)
  plainOffsetY: { type: Number, default: 0, min: -300, max: 300 }, // px nudge (+ down)
  plainMedia: { type: String, enum: ['image', 'lottie', 'video'], default: 'image' },
  lottieUrl: { type: String, default: '' },
  videoUrl: { type: String, default: '' },
  plainWidth: { type: Number, default: 0, min: 0, max: 1200 },     // 0 = default size

  // Where a tap goes. Route types ('quiz'/'train'/'games'/'viral') map to the
  // app's openStudioRoute(); 'url' uses targetValue as a link; 'news' uses it
  // as a newsId.
  targetType: {
    type: String,
    enum: ['quiz', 'train', 'games', 'viral', 'url', 'news'],
    default: 'quiz',
  },
  targetValue: { type: String, default: '' },

  // 'static' = plain transparent image: no card frame, no shadow, no rotation —
  // the image (GIF/PNG) just shows as-is. All others are the card/rotation styles.
  rotateStyle: { type: String, enum: ['spin', 'flip', 'coin', 'cube', 'mascot', 'static'], default: 'spin' },
  speedSeconds: { type: Number, default: 6, min: 2, max: 30 },

  // Which news cards show this ad. Empty = none pinned; one or more newsIds =
  // the ad's cube appears on each of those news cards. (displayNewsId kept for
  // backward compatibility with older saved ads.)
  displayNewsIds: { type: [String], default: [], index: true },
  displayNewsId: { type: String, default: '' },

  language: { type: String, default: '' },          // legacy single-language ('' = all)
  // One ad can target several languages at once. Empty = all languages. Takes
  // precedence over the legacy `language` when it has any entries. Additive —
  // old single-language ads keep working through `language`.
  languages: { type: [String], default: [] },
  // Which device size categories this cube ad shows on. Empty = all devices
  // (backward compatible). Keys: small|compact|standard|large|xlarge|tablet.
  deviceSizes: { type: [String], default: [] },
  // Server-managed "show on ALL recent posts" (no per-news pinning needed): the
  // public endpoint fills displayNewsIds with the live feed's ids each refresh.
  allPosts: { type: Boolean, default: false },
  // Auto-restrict to the device sizes where the cube does NOT cover the news
  // text (skips the "covered" devices, keeps only the "safe" ones).
  autoSafeDevices: { type: Boolean, default: false },
  isActive: { type: Boolean, default: false },      // OFF by default — safety

  author: { type: String, default: '' },
  authorId: { type: String, default: '' },
}, { timestamps: true });

threeDAdSchema.index({ isActive: 1, updatedAt: -1 });

module.exports = mongoose.model('ThreeDAd', threeDAdSchema);
