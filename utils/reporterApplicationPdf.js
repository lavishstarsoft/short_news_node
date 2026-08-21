'use strict';

/**
 * Server-side Reporter Application PDF (deterministic, no browser).
 * Images are fetched directly (no CORS), converted to PNG via sharp (handles
 * webp / octet-stream / any format), and embedded with pdfkit. A missing/invalid
 * image becomes an "Image not available" placeholder — never a blank/failed PDF.
 */

const PDFDocument = require('pdfkit');
const sharp = require('sharp');

const isUrl = (v) => typeof v === 'string' && /^https?:\/\//i.test(v);
const isImageUrl = (v) => isUrl(v) && /\.(jpe?g|png|webp|gif|bmp|tiff?)(\?|#|$)/i.test(v);

async function fetchImagePng(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
    if (!r.ok) return null;
    const src = Buffer.from(await r.arrayBuffer());
    if (!src.length) return null;
    // Convert ANY format → PNG (flattened on white), capped width to keep file small.
    return await sharp(src).flatten({ background: '#ffffff' }).resize({ width: 500, withoutEnlargement: true }).png().toBuffer();
  } catch (_) { return null; }
}

async function buildApplicationPdf(app, res) {
  const data = app.data || {};
  const entries = Object.entries(data);
  const textFields = entries.filter(([, v]) => !isUrl(v)).map(([k, v]) => ({ key: k, value: String(v) }));
  const mediaFields = entries.filter(([, v]) => isUrl(v)).map(([k, v]) => ({ key: k, value: String(v) }));

  // Pre-fetch every image → PNG buffer (parallel; each is fail-safe → null).
  const images = {};
  await Promise.all(mediaFields.map(async (f) => { images[f.key] = isImageUrl(f.value) ? await fetchImagePng(f.value) : null; }));

  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Reporter_Application_${app._id}.pdf"`);
  doc.pipe(res);

  const ML = doc.page.margins.left, MR = doc.page.width - doc.page.margins.right, cw = MR - ML;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  let y = 40;

  // ---- Header ----
  doc.fillColor('#b91c1c').font('Helvetica-Bold').fontSize(24).text('TEHELKA NEWS', ML, 40, { width: cw, align: 'center' });
  doc.fillColor('#111').font('Helvetica').fontSize(11).text('REPORTER APPLICATION FORM', ML, 70, { width: cw, align: 'center' });
  const boxW = 175, boxX = MR - boxW;
  doc.lineWidth(0.8).rect(boxX, 40, boxW, 54).stroke('#000');
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#000').text('OFFICE USE ONLY', boxX + 6, 45);
  doc.font('Helvetica').fontSize(8)
    .text('App ID: ' + String(app._id).substring(0, 8).toUpperCase(), boxX + 6, 58)
    .text('Date: ' + new Date(app.createdAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }), boxX + 6, 70)
    .text('Status: ' + String(app.status || '').toUpperCase(), boxX + 6, 82);
  doc.moveTo(ML, 100).lineTo(MR, 100).lineWidth(1.5).stroke('#000');
  y = 114;

  const sectionHeader = (title) => {
    if (y > bottom() - 90) { doc.addPage(); y = 40; }
    doc.lineWidth(0.8).rect(ML, y, cw, 22).fillAndStroke('#eef2f7', '#000');
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(12).text(title, ML + 8, y + 5, { width: cw - 16 });
    y += 30;
  };

  // ---- Section I: Applicant Details ----
  sectionHeader('I. APPLICANT DETAILS');
  const labelW = cw * 0.34;
  textFields.forEach((f) => {
    const label = f.key.replace(/_/g, ' ').toUpperCase();
    doc.font('Helvetica').fontSize(10);
    const rowH = Math.max(20, doc.heightOfString(f.value || '-', { width: cw - labelW - 16 }) + 10);
    if (y + rowH > bottom() - 20) { doc.addPage(); y = 40; }
    doc.lineWidth(0.6);
    doc.rect(ML, y, labelW, rowH).fillAndStroke('#f8fafc', '#000');
    doc.rect(ML + labelW, y, cw - labelW, rowH).stroke('#000');
    doc.fillColor('#111').font('Helvetica-Bold').fontSize(9).text(label, ML + 6, y + 5, { width: labelW - 12 });
    doc.font('Helvetica').fontSize(10).fillColor('#111').text(f.value || '-', ML + labelW + 8, y + 5, { width: cw - labelW - 16 });
    y += rowH;
  });
  y += 14;

  // ---- Section II: Attached Documents (2 boxes per row) ----
  if (mediaFields.length) {
    sectionHeader('II. ATTACHED DOCUMENTS & MEDIA');
    const colW = (cw - 12) / 2, boxH = 172;
    for (let i = 0; i < mediaFields.length; i += 2) {
      if (y + boxH > bottom() - 20) { doc.addPage(); y = 40; }
      for (let j = 0; j < 2; j++) {
        const f = mediaFields[i + j];
        if (!f) continue;
        const x = ML + j * (colW + 12);
        doc.lineWidth(0.8).rect(x, y, colW, boxH).stroke('#000');
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#111').text(f.key.replace(/_/g, ' ').toUpperCase(), x + 4, y + 5, { width: colW - 8, align: 'center' });
        const png = images[f.key];
        if (png) {
          try { doc.image(png, x + 6, y + 22, { fit: [colW - 12, boxH - 30], align: 'center', valign: 'center' }); }
          catch (_) { doc.font('Helvetica').fontSize(10).fillColor('#888').text('Image not available', x + 4, y + boxH / 2, { width: colW - 8, align: 'center' }); }
        } else if (isImageUrl(f.value)) {
          doc.font('Helvetica').fontSize(10).fillColor('#888').text('Image not available', x + 4, y + boxH / 2, { width: colW - 8, align: 'center' });
        } else {
          const name = f.value.substring(f.value.lastIndexOf('/') + 1).slice(0, 40);
          doc.font('Helvetica').fontSize(9).fillColor('#555').text('Document attached\n' + name, x + 4, y + boxH / 2 - 10, { width: colW - 8, align: 'center' });
        }
      }
      y += boxH + 10;
    }
  }

  // ---- Section III: Declaration ----
  y += 4;
  sectionHeader('III. DECLARATION & APPROVAL');
  doc.font('Helvetica').fontSize(9).fillColor('#111').text(
    'I hereby declare that all the information provided by me in this application is true and correct to the best of my knowledge and belief. I understand that any misrepresentation or omission of facts may result in the rejection of my application or termination of my engagement as a reporter for Tehelka News.',
    ML + 2, y, { width: cw - 4 }
  );
  y = doc.y + 46;
  if (y > bottom() - 40) { doc.addPage(); y = 80; }
  doc.lineWidth(0.8).moveTo(ML, y).lineTo(ML + 190, y).stroke('#000');
  doc.moveTo(MR - 190, y).lineTo(MR, y).stroke('#000');
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#111').text('Signature of Applicant', ML, y + 5, { width: 190, align: 'center' });
  doc.text('Authorized Signatory', MR - 190, y + 5, { width: 190, align: 'center' });
  if (app.adminNotes) {
    doc.moveDown(2).font('Helvetica').fontSize(9).fillColor('#111').text('Official Remarks: ' + String(app.adminNotes), ML, doc.y, { width: cw });
  }

  doc.end();
}

module.exports = { buildApplicationPdf };
