'use strict';

/**
 * staffCategoryController — admin-managed Display Role categories.
 * All mutations are admin/superadmin only (same rule as the editors page).
 */

const StaffCategory = require('../models/StaffCategory');

function isAdmin(req) {
  return req.admin && (req.admin.role === 'admin' || req.admin.role === 'superadmin');
}

/** Active categories, sorted — the source of truth for the Display Role dropdown. */
async function getActiveCategories() {
  return StaffCategory.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).lean();
}

// GET /staff-categories — management page.
exports.renderPage = async (req, res) => {
  if (!isAdmin(req)) return res.status(403).send('Access denied. Admins only.');
  await StaffCategory.seedDefaults();
  const categories = await StaffCategory.find({}).sort({ sortOrder: 1, name: 1 }).lean();
  res.render('staff-categories', { admin: req.admin, categories, activePage: 'staff-categories' });
};

// GET /staff-categories/api — list (JSON).
exports.list = async (req, res) => {
  const categories = await StaffCategory.find({}).sort({ sortOrder: 1, name: 1 }).lean();
  res.json({ success: true, categories });
};

// POST /staff-categories/api — create.
exports.create = async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admins only.' });
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  try {
    const cat = await StaffCategory.create({
      name,
      pdfEligible: !!req.body.pdfEligible,
      sortOrder: Number(req.body.sortOrder) || 0,
      isActive: req.body.isActive === undefined ? true : !!req.body.isActive
    });
    res.json({ success: true, category: cat });
  } catch (e) {
    if (e && e.code === 11000) return res.status(409).json({ error: 'Category already exists.' });
    res.status(500).json({ error: 'Failed to create category.' });
  }
};

// PUT /staff-categories/api/:id — update (name/pdfEligible/isActive/sortOrder).
exports.update = async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admins only.' });
  const update = {};
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
    update.name = name;
  }
  if (req.body.pdfEligible !== undefined) update.pdfEligible = !!req.body.pdfEligible;
  if (req.body.isActive !== undefined) update.isActive = !!req.body.isActive;
  if (req.body.sortOrder !== undefined) update.sortOrder = Number(req.body.sortOrder) || 0;
  try {
    const cat = await StaffCategory.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
    if (!cat) return res.status(404).json({ error: 'Not found.' });
    res.json({ success: true, category: cat });
  } catch (e) {
    if (e && e.code === 11000) return res.status(409).json({ error: 'Category name already exists.' });
    res.status(500).json({ error: 'Failed to update category.' });
  }
};

exports.getActiveCategories = getActiveCategories;
