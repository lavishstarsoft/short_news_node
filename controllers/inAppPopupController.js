'use strict';

const InAppPopup = require('../models/InAppPopup');
const Language = require('../models/Language');

const clean = (v) => (v == null ? undefined : String(v).trim());

// GET /admin/in-app-popup  (management page)
exports.renderPage = async (req, res) => {
  try {
    let languages = [];
    try { languages = await Language.getActiveLanguages(); } catch (_) { languages = []; }
    res.render('in-app-popup', { admin: req.admin, activePage: 'in-app-popup', languages });
  } catch (e) { console.error('inAppPopup renderPage:', e.message); res.status(500).send('Server Error'); }
};

// POST /admin/api/in-app-popup
exports.create = async (req, res) => {
  try {
    const language = clean(req.body.language);
    const title = clean(req.body.title);
    if (!language || !title) return res.status(400).json({ error: 'language and title are required.' });
    const doc = await InAppPopup.create({
      language,
      title,
      message: clean(req.body.message) || '',
      imageUrl: clean(req.body.imageUrl) || '',
      buttonText: clean(req.body.buttonText) || '',
      actionUrl: clean(req.body.actionUrl) || '',
      isActive: req.body.isActive === true || req.body.isActive === 'true',
      triggerAfterSwipes: Math.max(1, parseInt(req.body.triggerAfterSwipes, 10) || 3),
    });
    res.status(201).json({ success: true, popup: doc });
  } catch (e) { console.error('inAppPopup create:', e.message); res.status(500).json({ error: 'Failed to create popup.' }); }
};

// PUT /admin/api/in-app-popup/:id
exports.update = async (req, res) => {
  try {
    const doc = await InAppPopup.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Popup not found.' });
    ['language', 'title', 'message', 'imageUrl', 'buttonText', 'actionUrl'].forEach((k) => {
      if (req.body[k] !== undefined) doc[k] = clean(req.body[k]) || '';
    });
    if (req.body.isActive !== undefined) doc.isActive = req.body.isActive === true || req.body.isActive === 'true';
    if (req.body.triggerAfterSwipes !== undefined) doc.triggerAfterSwipes = Math.max(1, parseInt(req.body.triggerAfterSwipes, 10) || 3);
    await doc.save();
    res.json({ success: true, popup: doc });
  } catch (e) { console.error('inAppPopup update:', e.message); res.status(500).json({ error: 'Failed to update popup.' }); }
};

// GET /admin/api/in-app-popup
exports.getAll = async (req, res) => {
  try {
    const items = await InAppPopup.find({}).sort({ updatedAt: -1 }).lean();
    res.json({ count: items.length, items });
  } catch (e) { console.error('inAppPopup getAll:', e.message); res.status(500).json({ error: 'Failed to load popups.' }); }
};

// PATCH /admin/api/in-app-popup/:id/toggle
// One active popup per language: activating this one deactivates its siblings.
exports.toggleActive = async (req, res) => {
  try {
    const doc = await InAppPopup.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Popup not found.' });
    doc.isActive = !doc.isActive;
    if (doc.isActive) {
      await InAppPopup.updateMany({ _id: { $ne: doc._id }, language: doc.language }, { $set: { isActive: false } });
    }
    await doc.save();
    res.json({ success: true, isActive: doc.isActive });
  } catch (e) { console.error('inAppPopup toggle:', e.message); res.status(500).json({ error: 'Failed to toggle popup.' }); }
};

// GET /api/public/in-app-popup?language=te  → single active popup (or null)
exports.getPublic = async (req, res) => {
  try {
    const language = clean(req.query.language) || 'te';
    const popup = await InAppPopup.findOne({ language, isActive: true }).sort({ updatedAt: -1 }).lean();
    if (!popup) return res.json({ popup: null });
    res.json({ popup: {
      id: String(popup._id),
      language: popup.language,
      title: popup.title,
      message: popup.message || '',
      imageUrl: popup.imageUrl || '',
      buttonText: popup.buttonText || '',
      actionUrl: popup.actionUrl || '',
      triggerAfterSwipes: popup.triggerAfterSwipes || 3,
    } });
  } catch (e) { console.error('inAppPopup getPublic:', e.message); res.status(500).json({ error: 'Failed to load popup.' }); }
};
