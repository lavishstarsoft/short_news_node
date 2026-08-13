'use strict';
/**
 * generate_up_allocation_pdf.js — Uttar Pradesh District Allocation Report.
 *
 * READ-ONLY on the database (only reads Location + Admin; never writes). Derives
 * the three allocations from the actual DB (source of truth), validates that they
 * partition the UP district set with no duplicates and no missing entries, then
 * renders a professional PDF using the existing pdfkit dependency.
 *
 *   node generate_up_allocation_pdf.js
 */

require('dotenv').config({ path: __dirname + '/.env' });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const PDFDocument = require('pdfkit');

const OUT = path.join(__dirname, 'UP_District_Allocation_Report.pdf');
const norm = (s) => String(s || '').trim().toLowerCase();

const COLORS = { brand: '#b91c1c', headerBg: '#1f2937', headerText: '#ffffff', rowAlt: '#f8fafc', border: '#e5e7eb', text: '#111827', muted: '#6b7280', ok: '#15803d' };

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const Location = require('./models/Location');
  const Admin = require('./models/Admin');

  // 1) Source of truth: UP districts from Location collection.
  const upDocs = await Location.find({ locationType: 'district', parentName: 'Uttar Pradesh' })
    .select('name').sort({ name: 1 }).lean();
  const upNames = upDocs.map(d => d.name.trim());
  const upSet = new Set(upNames.map(norm));

  // 2) Allocations from Admin records (intersect with the UP set only).
  const getAssigned = async (regex) => {
    const a = await Admin.findOne({ name: { $regex: regex, $options: 'i' }, role: 'subeditor' })
      .select('name assignedDistricts').lean();
    if (!a) throw new Error(`Admin not found for /${regex}/`);
    const list = (a.assignedDistricts || []).map(x => x.trim()).filter(x => upSet.has(norm(x)));
    return { name: a.name, list };
  };
  const ashraf = await getAssigned('ashraf');
  const praveen = await getAssigned('praveen');

  // 3) Remaining = UP - Ashraf - Praveen  (this is Ashwani's set, derived from DB).
  const taken = new Set([...ashraf.list, ...praveen.list].map(norm));
  const remaining = upNames.filter(n => !taken.has(norm(n)));
  const ashwaniAdmin = await Admin.findOne({ name: { $regex: 'ashwani|aswin|ashwin', $options: 'i' }, role: 'subeditor' }).select('name').lean();
  const ashwaniName = ashwaniAdmin ? ashwaniAdmin.name : 'Ashwani Awasthi';

  // 4) Validation (no duplicates, no missing, no overlap, sums correct).
  const errors = [];
  const dup = (arr) => arr.filter((v, i) => arr.map(norm).indexOf(norm(v)) !== i);
  const overlap = ashraf.list.filter(d => praveen.list.map(norm).includes(norm(d)));
  if (dup(ashraf.list).length) errors.push('Duplicate in Ashraf: ' + dup(ashraf.list));
  if (dup(praveen.list).length) errors.push('Duplicate in Praveen: ' + dup(praveen.list));
  if (dup(remaining).length) errors.push('Duplicate in Remaining: ' + dup(remaining));
  if (overlap.length) errors.push('Ashraf/Praveen overlap: ' + overlap);
  const union = new Set([...ashraf.list, ...praveen.list, ...remaining].map(norm));
  const missing = upNames.filter(n => !union.has(norm(n)));
  if (missing.length) errors.push('Missing from allocation: ' + missing);
  if (ashraf.list.length + praveen.list.length + remaining.length !== upNames.length) {
    errors.push(`Sum ${ashraf.list.length}+${praveen.list.length}+${remaining.length} != total ${upNames.length}`);
  }

  const summary = {
    total: upNames.length,
    ashraf: ashraf.list.length, ashrafName: ashraf.name,
    praveen: praveen.list.length, praveenName: praveen.name,
    ashwani: remaining.length, ashwaniName,
    duplicates: dup(ashraf.list).length + dup(praveen.list).length + dup(remaining.length ? remaining : []).length + overlap.length,
    missing: missing.length,
    errors
  };
  console.log('VALIDATION:', JSON.stringify(summary, null, 2));
  if (errors.length) { console.error('❌ Validation failed — PDF NOT generated.'); await mongoose.connection.close(); process.exit(1); }

  // 5) Render PDF.
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const stream = fs.createWriteStream(OUT);
  doc.pipe(stream);
  const pageW = doc.page.width, ML = doc.page.margins.left, MR = doc.page.width - doc.page.margins.right;
  const usableW = MR - ML;
  const bottom = () => doc.page.height - doc.page.margins.bottom - 20;

  // Title
  doc.fillColor(COLORS.brand).font('Helvetica-Bold').fontSize(20)
    .text('Uttar Pradesh District Allocation Report', ML, 55, { width: usableW, align: 'center' });
  doc.moveDown(0.3);
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(10)
    .text('Tehelka News  ·  Generated ' + new Date().toLocaleString('en-IN') + '  ·  Source: Location + Admin collections (DB)', { width: usableW, align: 'center' });

  // Summary box
  let y = 110;
  doc.roundedRect(ML, y, usableW, 78, 6).fill('#f9fafb').stroke(COLORS.border);
  doc.fillColor(COLORS.text).font('Helvetica-Bold').fontSize(12).text('Summary', ML + 14, y + 10);
  doc.font('Helvetica').fontSize(11).fillColor(COLORS.text);
  const sLines = [
    `Total Districts: ${summary.total}`,
    `ASRFA (${summary.ashrafName}): ${summary.ashraf}`,
    `PRAVEEN (${summary.praveenName}): ${summary.praveen}`,
    `ASWIN (${summary.ashwaniName}): ${summary.ashwani}`
  ];
  doc.text(sLines[0] + '        ' + sLines[1], ML + 14, y + 32);
  doc.text(sLines[2] + '        ' + sLines[3], ML + 14, y + 52);
  y += 100;

  // Table renderer (S.No | District Name)
  function section(heading, rows) {
    if (y > bottom() - 60) { doc.addPage(); y = 55; }
    doc.fillColor(COLORS.brand).font('Helvetica-Bold').fontSize(13).text(heading, ML, y);
    y += 22;
    const c1 = 70, c2 = usableW - c1, rowH = 20;
    const drawHead = () => {
      doc.rect(ML, y, usableW, rowH).fill(COLORS.headerBg);
      doc.fillColor(COLORS.headerText).font('Helvetica-Bold').fontSize(10);
      doc.text('S.No', ML + 8, y + 6, { width: c1 - 12 });
      doc.text('District Name', ML + c1 + 8, y + 6, { width: c2 - 12 });
      y += rowH;
    };
    drawHead();
    doc.font('Helvetica').fontSize(10);
    rows.forEach((name, i) => {
      if (y > bottom()) { doc.addPage(); y = 55; drawHead(); doc.font('Helvetica').fontSize(10); }
      if (i % 2 === 1) doc.rect(ML, y, usableW, rowH).fill(COLORS.rowAlt);
      doc.fillColor(COLORS.text);
      doc.text(String(i + 1), ML + 8, y + 5, { width: c1 - 12 });
      doc.text(name, ML + c1 + 8, y + 5, { width: c2 - 12 });
      doc.strokeColor(COLORS.border).moveTo(ML, y + rowH).lineTo(MR, y + rowH).stroke();
      y += rowH;
    });
    y += 18;
  }

  section(`1. ASRFA Allocated Districts — ${ashraf.list.length}  (${ashraf.name})`, ashraf.list);
  section(`2. PRAVEEN Allocated Districts — ${praveen.list.length}  (${praveen.name})`, praveen.list);
  section(`3. ASWIN Allocated Districts — ${remaining.length}  (${ashwaniName})`, remaining);

  // Verification summary
  if (y > bottom() - 90) { doc.addPage(); y = 55; }
  doc.roundedRect(ML, y, usableW, 78, 6).fill('#f0fdf4').stroke('#bbf7d0');
  doc.fillColor(COLORS.ok).font('Helvetica-Bold').fontSize(12).text('Verification Summary', ML + 14, y + 10);
  doc.fillColor(COLORS.text).font('Helvetica').fontSize(11);
  doc.text(`Total = ${summary.ashraf} + ${summary.praveen} + ${summary.ashwani} = ${summary.ashraf + summary.praveen + summary.ashwani}`, ML + 14, y + 32);
  doc.text(`Duplicate districts = ${summary.duplicates}        Missing districts = ${summary.missing}`, ML + 14, y + 52);

  doc.end();
  await new Promise((r) => stream.on('finish', r));
  await mongoose.connection.close();

  const st = fs.statSync(OUT);
  console.log(`✅ PDF written: ${OUT} (${st.size} bytes)`);
  process.exit(0);
})().catch(async (e) => { console.error('ERROR:', e.message); try { await mongoose.connection.close(); } catch (_) {} process.exit(1); });
