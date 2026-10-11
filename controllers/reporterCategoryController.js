'use strict';

const Category = require('../models/Category');

// Categories the reporter can file news under. Reuses the EXISTING Category
// collection (the same one the Next.js admin dashboard manages) and its
// purpose-built `showToReporters` flag — no new/duplicate category data.
//
// Primary set: categories admins explicitly marked `showToReporters`. If none
// are flagged yet, we fall back to the active in-app news categories so the
// reporter flow is never blocked. Read-only, additive.
async function listCategories(req, res) {
  try {
    const connected = req.app.locals.isConnectedToMongoDB;

    let docs;
    if (connected) {
      const base = { isActive: true, type: { $in: ['news', null] } };
      docs = await Category.find({ ...base, showToReporters: true })
        .sort({ order: 1, name: 1 })
        .lean();
      if (!docs.length) {
        docs = await Category.find({ ...base, showInApp: true })
          .sort({ order: 1, name: 1 })
          .lean();
      }
    } else {
      const all = (req.app.locals.categoryData || []).filter(
        (c) => c.isActive !== false && (c.type || 'news') === 'news',
      );
      docs = all.filter((c) => c.showToReporters === true);
      if (!docs.length) docs = all.filter((c) => c.showInApp !== false);
      docs.sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.name).localeCompare(String(b.name)));
    }

    const categories = docs.map((c) => ({
      name: c.name,
      displayName: c.displayName && String(c.displayName).trim() ? c.displayName : c.name,
      icon: c.icon || '',
      color: c.color || '',
    }));

    res.json({ categories });
  } catch (err) {
    console.error('reporter categories error:', err);
    res.status(500).json({ error: 'Unable to load categories. Please try again.' });
  }
}

module.exports = { listCategories };
