'use strict';

/**
 * Sub-Editor Work Report — Super Admin only (routes are gated with
 * requireSuperAdmin). Read-only: never writes to News/Admin.
 */

const Admin = require('../models/Admin');
const report = require('../services/reports/subEditorWorkReport');
const { getActiveLanguages } = require('../services/languageRegistry');

function parseFilters(query) {
  const period = report.resolvePeriod({ date: query.date, from: query.from, to: query.to });
  const language = query.language && /^[a-z]{2,3}$/i.test(query.language) ? String(query.language).toLowerCase() : null;
  const authorId = query.authorId && /^[a-f0-9]{24}$/i.test(query.authorId) ? query.authorId : null;
  return { period, language, authorId };
}

async function renderPage(req, res) {
  try {
    const subEditors = await Admin.find({ role: 'subeditor' }).select('_id name username isActive').sort({ name: 1 }).lean();
    res.render('sub-editor-work-report', {
      title: 'Sub-Editor Work Report',
      admin: req.admin,
      subEditors,
      languages: getActiveLanguages().map((l) => ({ code: l.code, name: l.name })),
      today: report.istDateStr(new Date()),
      maxRangeDays: report.MAX_RANGE_DAYS,
    });
  } catch (err) {
    console.error('[sub-editor-work-report] render failed:', err);
    res.status(500).send('Could not load the report page');
  }
}

async function summaryJson(req, res) {
  try {
    const { period, language, authorId } = parseFilters(req.query);
    const data = await report.collectData({ period, language, authorId });
    res.json({ success: true, ...report.toSummaryJson(data, period) });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message || 'Bad request' });
  }
}

async function downloadPdf(req, res) {
  let filters;
  try {
    filters = parseFilters(req.query);
  } catch (err) {
    return res.status(400).send(err.message || 'Bad request');
  }
  try {
    const { period, language, authorId } = filters;
    const data = await report.collectData({ period, language, authorId });
    const authorName = authorId ? ((data.editors[0] && (data.editors[0].name || data.editors[0].username)) || authorId) : null;
    const generatedBy = (req.admin && (req.admin.name || req.admin.username)) || 'Super Admin';
    const { doc, reportId } = report.buildPdf(data, { period, generatedBy, filters: { language, authorName } });

    const fname = `Sub-Editor-Work-Report_${period.fromStr}${period.days > 1 ? '_to_' + period.toStr : ''}${language ? '_' + language.toUpperCase() : ''}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.setHeader('X-Report-Id', reportId);
    doc.on('error', (e) => { console.error('[sub-editor-work-report] pdf stream error:', e); if (!res.headersSent) res.status(500).end(); });
    doc.pipe(res);
    doc.end();
    console.log(`[sub-editor-work-report] ${reportId} ${period.fromStr}..${period.toStr} by ${generatedBy}`);
  } catch (err) {
    console.error('[sub-editor-work-report] failed:', err);
    if (!res.headersSent) res.status(500).send('Could not generate the report');
  }
}

/** One-glance performance PDF for the SELECTED sub editors (with scores). */
async function performancePdf(req, res) {
  let filters;
  try {
    filters = parseFilters(req.query);
  } catch (err) {
    return res.status(400).send(err.message || 'Bad request');
  }
  const ids = String(req.query.authorIds || '').split(',').map((s) => s.trim()).filter((s) => /^[a-f0-9]{24}$/i.test(s));
  if (!ids.length) return res.status(400).send('Select at least one sub editor');
  if (ids.length > 60) return res.status(400).send('Too many sub editors selected (max 60)');
  try {
    const { period, language } = filters;
    const perf = require('../services/reports/subEditorPerformancePdf');
    // Collect the WHOLE team so the score target (team 75th percentile) is fair,
    // then render only the selected rows.
    const data = await report.collectData({ period, language });
    perf.computeScores(data.rows);
    const generatedBy = (req.admin && (req.admin.name || req.admin.username)) || 'Super Admin';
    const logoPath = require('path').join(__dirname, '..', 'public', 'images', 'logo.png');
    const { doc, reportId, selected } = perf.buildPerformancePdf({ rows: data.rows, totals: data.totals, period, selectedIds: ids, generatedBy, logoPath });
    const fname = `Sub-Editor-Performance_${period.fromStr}${period.days > 1 ? '_to_' + period.toStr : ''}${language ? '_' + language.toUpperCase() : ''}_${selected}editors.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.setHeader('X-Report-Id', reportId);
    doc.on('error', (e) => { console.error('[sub-editor-performance] pdf stream error:', e); if (!res.headersSent) res.status(500).end(); });
    doc.pipe(res);
    doc.end();
    console.log(`[sub-editor-performance] ${reportId} ${period.fromStr}..${period.toStr} ${selected} editors by ${generatedBy}`);
  } catch (err) {
    console.error('[sub-editor-performance] failed:', err);
    if (!res.headersSent) res.status(500).send('Could not generate the performance report');
  }
}

module.exports = { renderPage, summaryJson, downloadPdf, performancePdf };
