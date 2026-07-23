/**
 * Reusable branded PDF report export (Tehelka News).
 * Manual pagination only — overflow-safe cells so PDFKit never auto-adds blank pages.
 */
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { formatIndianDate, formatIndianTime } = require('./indianDateTime');

const DEFAULT_LOGO = path.join(__dirname, '../public/images/logo.png');

const COLORS = {
  brand: '#b91c1c',
  headerBg: '#1f2937',
  headerText: '#ffffff',
  rowAlt: '#f8fafc',
  border: '#e5e7eb',
  text: '#111827',
  muted: '#6b7280',
  line: '#d1d5db',
  summaryBg: '#f9fafb',
  summaryBorder: '#e5e7eb',
  netBg: '#fef2f2',
  credit: '#15803d',
  debit: '#b91c1c'
};

const FOOTER_RESERVE = 26;
const MAX_CELL_LINES = 2;

/**
 * Format number as Indian Rupee currency: ₹1,25,450.00
 * @param {number|string} value
 * @returns {string}
 */
function formatINR(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '₹0.00';
  const fixed = Math.abs(n).toFixed(2);
  const [intPart, dec] = fixed.split('.');
  let indian = intPart;
  if (intPart.length > 3) {
    const last3 = intPart.slice(-3);
    const rest = intPart.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    indian = `${rest},${last3}`;
  }
  const sign = n < 0 ? '-' : '';
  return `${sign}₹${indian}.${dec}`;
}

/**
 * Stream a branded PDF table report to an Express response.
 *
 * @param {object} options
 * @param {import('express').Response} options.res
 * @param {string} options.filename
 * @param {string} options.title
 * @param {string} [options.adminName]
 * @param {string} [options.dateRange]
 * @param {string[]} options.columns
 * @param {Array<Array<string|number>>} options.rows
 * @param {number} [options.totalRecords]
 * @param {number[]} [options.rightAlignColumns] - 0-based column indexes to right-align
 * @param {object|null} [options.summary] - optional financial summary (page 1 only)
 * @param {string} [options.logoPath]
 */
function streamPdfReport({
  res,
  filename,
  title,
  adminName = '—',
  dateRange = 'All dates',
  columns = [],
  rows = [],
  totalRecords,
  rightAlignColumns = [],
  summary = null,
  logoPath = DEFAULT_LOGO
}) {
  const colCount = Math.max(columns.length, 1);
  const useLandscape = colCount >= 7;
  const marginSize = useLandscape ? 36 : 40;
  const pageOpts = {
    size: 'A4',
    layout: useLandscape ? 'landscape' : 'portrait',
    margins: {
      top: marginSize,
      bottom: marginSize,
      left: marginSize,
      right: marginSize
    }
  };

  const doc = new PDFDocument({
    ...pageOpts,
    autoFirstPage: true,
    bufferPages: true,
    info: {
      Title: title,
      Author: 'Tehelka News Admin',
      Creator: 'ShortNews Admin Panel'
    }
  });

  // Helvetica cannot render ₹ — prefer a Unicode font when available
  const unicodeFontPath = [
    path.join(__dirname, '../public/fonts/NotoSans-Regular.ttf'),
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/Library/Fonts/Arial Unicode.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'
  ].find((p) => fs.existsSync(p));
  let bodyFont = 'Helvetica';
  let bodyFontBold = 'Helvetica-Bold';
  if (unicodeFontPath) {
    try {
      doc.registerFont('ReportBody', unicodeFontPath);
      bodyFont = 'ReportBody';
      bodyFontBold = 'ReportBody';
    } catch (_) {
      /* keep Helvetica */
    }
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);

  const pageWidth = doc.page.width;
  const margin = doc.page.margins.left;
  const contentWidth = pageWidth - margin - doc.page.margins.right;
  // Rows must end above footer band; footer stays at/above maxY with lineBreak:false
  const contentBottom = () => doc.page.maxY() - FOOTER_RESERVE;

  const now = new Date();
  const generatedDate = formatIndianDate(now);
  const generatedTime = formatIndianTime(now);
  const recordCount = totalRecords != null ? totalRecords : rows.length;
  const rightAlignSet = new Set(rightAlignColumns);

  const colWidths = computeColumnWidths(columns, rows, contentWidth);
  const fontSize = colCount >= 10 ? 7 : colCount >= 7 ? 8 : 9;
  const headerFontSize = fontSize + 0.5;
  const rowPadY = 4;
  const cellPadX = 3;
  const lineHeight = fontSize + 2;
  const maxCellContentH = lineHeight * MAX_CELL_LINES;

  const hasLogo = logoPath && fs.existsSync(logoPath);

  /** Draw text inside a fixed box — never triggers PDFKit auto page-break. */
  function safeText(str, x, y, width, height, opts = {}) {
    const text = String(str == null ? '' : str);
    doc.text(text, x, y, {
      width,
      height,
      ellipsis: true,
      lineBreak: true,
      ...opts
    });
    // Keep internal cursor inside the current page so PDFKit never auto-adds a page
    doc.x = margin;
    doc.y = Math.min(y, contentBottom());
  }

  function drawPage1Header() {
    let cursorY = margin;

    if (hasLogo) {
      try {
        doc.image(logoPath, margin, cursorY, { height: 32, fit: [110, 32] });
      } catch (_) {
        /* optional */
      }
    }

    const titleX = hasLogo ? margin + 120 : margin;
    const titleW = contentWidth - (hasLogo ? 120 : 0);
    doc.fillColor(COLORS.brand).font(bodyFontBold).fontSize(15);
    safeText('Tehelka News', titleX, cursorY, titleW, 18, { align: 'left', lineBreak: false });

    doc.fillColor(COLORS.text).font(bodyFontBold).fontSize(12);
    safeText(title, titleX, cursorY + 18, titleW, 16, { align: 'left', lineBreak: false });

    cursorY += 48;
    doc
      .moveTo(margin, cursorY)
      .lineTo(margin + contentWidth, cursorY)
      .strokeColor(COLORS.brand)
      .lineWidth(1.5)
      .stroke();

    cursorY += 10;
    doc.font(bodyFont).fontSize(9).fillColor(COLORS.muted);
    const metaH = 12;
    const metaColW = contentWidth / 2 - 8;
    const metaLeft = [
      `Generated Date: ${generatedDate}`,
      `Generated Time: ${generatedTime}`,
      `Generated By: ${adminName || '—'}`
    ];
    const metaRight = [
      `Selected Date Range: ${dateRange || 'All dates'}`,
      `Total Records: ${recordCount}`
    ];
    metaLeft.forEach((line, i) => {
      doc.fillColor(COLORS.muted).font(bodyFont).fontSize(9);
      safeText(line, margin, cursorY + i * metaH, metaColW, metaH, { lineBreak: false });
    });
    metaRight.forEach((line, i) => {
      doc.fillColor(COLORS.muted).font(bodyFont).fontSize(9);
      safeText(line, margin + contentWidth / 2, cursorY + i * metaH, metaColW, metaH, {
        align: 'right',
        lineBreak: false
      });
    });
    cursorY += Math.max(metaLeft.length, metaRight.length) * metaH + 10;

    if (summary) {
      cursorY = drawSummary(cursorY, summary);
    }

    return cursorY;
  }

  function drawContinuationHeader() {
    let cursorY = margin;
    if (hasLogo) {
      try {
        doc.image(logoPath, margin, cursorY, { height: 20, fit: [70, 20] });
      } catch (_) {
        /* optional */
      }
    }
    const titleX = hasLogo ? margin + 78 : margin;
    doc.fillColor(COLORS.brand).font(bodyFontBold).fontSize(10);
    safeText('Tehelka News', titleX, cursorY, 120, 12, { lineBreak: false });
    doc.fillColor(COLORS.muted).font(bodyFont).fontSize(9);
    safeText(`${title} (continued)`, titleX + 110, cursorY + 1, contentWidth - (titleX - margin) - 110, 12, {
      lineBreak: false
    });
    cursorY += 26;
    doc
      .moveTo(margin, cursorY)
      .lineTo(margin + contentWidth, cursorY)
      .strokeColor(COLORS.line)
      .lineWidth(0.8)
      .stroke();
    return cursorY + 8;
  }

  function drawSummary(startY, s) {
    const pad = 10;
    const kpiH = 36;
    const titleH = 16;
    const showBalances = s.showOpeningClosing === true;
    const balanceH = showBalances ? 28 : 0;
    const boxH = pad + titleH + 6 + kpiH + (showBalances ? 8 + balanceH : 0) + pad;

    doc.save();
    doc.roundedRect(margin, startY, contentWidth, boxH, 4).fillAndStroke(COLORS.summaryBg, COLORS.summaryBorder);
    doc.restore();

    let y = startY + pad;
    doc.fillColor(COLORS.text).font(bodyFontBold).fontSize(10);
    safeText('SUMMARY', margin + pad, y, contentWidth - pad * 2, titleH, { lineBreak: false });
    y += titleH + 4;

    const kpis = [
      { label: 'Date Range', value: String(s.dateRange || dateRange || 'All dates'), highlight: false },
      { label: 'Total Transactions', value: String(s.totalTransactions ?? recordCount), highlight: false },
      { label: 'Total Credit', value: String(s.totalCreditFormatted || formatINR(s.totalCredit)), highlight: false, color: COLORS.credit },
      { label: 'Total Debit', value: String(s.totalDebitFormatted || formatINR(s.totalDebit)), highlight: false, color: COLORS.debit },
      { label: 'Net Amount', value: String(s.netAmountFormatted || formatINR(s.netAmount)), highlight: true }
    ];

    const gap = 8;
    const kpiW = (contentWidth - pad * 2 - gap * (kpis.length - 1)) / kpis.length;
    kpis.forEach((kpi, i) => {
      const x = margin + pad + i * (kpiW + gap);
      if (kpi.highlight) {
        doc.save();
        doc.roundedRect(x, y, kpiW, kpiH, 3).fill(COLORS.netBg);
        doc.restore();
      }
      doc.fillColor(COLORS.muted).font(bodyFont).fontSize(7);
      safeText(kpi.label, x + 4, y + 4, kpiW - 8, 10, { lineBreak: false });
      doc
        .fillColor(kpi.highlight ? COLORS.brand : kpi.color || COLORS.text)
        .font(bodyFontBold)
        .fontSize(kpi.highlight ? 10 : 9);
      safeText(kpi.value, x + 4, y + 16, kpiW - 8, 16, { lineBreak: false });
    });
    y += kpiH;

    if (showBalances) {
      y += 8;
      const half = (contentWidth - pad * 2 - gap) / 2;
      [
        { label: 'Opening Balance', value: String(s.openingBalanceFormatted || formatINR(s.openingBalance)) },
        { label: 'Closing Balance', value: String(s.closingBalanceFormatted || formatINR(s.closingBalance)) }
      ].forEach((b, i) => {
        const x = margin + pad + i * (half + gap);
        doc.fillColor(COLORS.muted).font(bodyFont).fontSize(7);
        safeText(b.label, x, y, half, 10, { lineBreak: false });
        doc.fillColor(COLORS.text).font(bodyFontBold).fontSize(10);
        safeText(b.value, x, y + 11, half, 14, { lineBreak: false });
      });
      y += balanceH;
    }

    return startY + boxH + 12;
  }

  function drawTableHeader(y) {
    const h = Math.max(18, lineHeight + rowPadY * 2);
    doc.save();
    doc.rect(margin, y, contentWidth, h).fill(COLORS.headerBg);
    doc.restore();

    let x = margin;
    columns.forEach((header, i) => {
      const align = rightAlignSet.has(i) ? 'right' : 'left';
      doc.fillColor(COLORS.headerText).font(bodyFontBold).fontSize(headerFontSize);
      safeText(String(header), x + cellPadX, y + rowPadY, colWidths[i] - cellPadX * 2, lineHeight, {
        align,
        lineBreak: false
      });
      x += colWidths[i];
    });
    return y + h;
  }

  function measureRowHeight() {
    return Math.max(16, maxCellContentH + rowPadY * 2);
  }

  function drawRow(y, cells, alt) {
    const h = measureRowHeight();
    if (alt) {
      doc.save();
      doc.rect(margin, y, contentWidth, h).fill(COLORS.rowAlt);
      doc.restore();
    }
    doc.rect(margin, y, contentWidth, h).strokeColor(COLORS.border).lineWidth(0.4).stroke();

    let x = margin;
    cells.forEach((cell, i) => {
      const align = rightAlignSet.has(i) ? 'right' : 'left';
      doc.fillColor(COLORS.text).font(bodyFont).fontSize(fontSize);
      safeText(cell, x + cellPadX, y + rowPadY, colWidths[i] - cellPadX * 2, maxCellContentH, {
        align
      });
      x += colWidths[i];
    });
    return y + h;
  }

  function startNewPage(isFirst) {
    if (!isFirst) {
      doc.addPage(pageOpts);
    }
    const y0 = isFirst ? drawPage1Header() : drawContinuationHeader();
    return drawTableHeader(y0);
  }

  let y = startNewPage(true);
  const rowH = measureRowHeight();

  if (!rows.length) {
    doc.fillColor(COLORS.muted).font(bodyFont).fontSize(10);
    safeText('No records match the selected filters.', margin, y + 16, contentWidth, 14, {
      align: 'center',
      lineBreak: false
    });
  } else {
    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      const cells = columns.map((_, i) => (row[i] == null ? '' : row[i]));
      if (y + rowH > contentBottom()) {
        y = startNewPage(false);
      }
      y = drawRow(y, cells, idx % 2 === 1);
    }
  }

  // Footers on existing pages only — never addPage here
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const footerY = doc.page.maxY() - 14;
    doc
      .moveTo(margin, footerY - 6)
      .lineTo(margin + contentWidth, footerY - 6)
      .strokeColor(COLORS.line)
      .lineWidth(0.5)
      .stroke();

    doc.fillColor(COLORS.muted).font(bodyFont).fontSize(8);
    // lineBreak:false + stay above maxY prevents blank pages from footer
    doc.text('Tehelka News  ·  Confidential Report', margin, footerY, {
      width: contentWidth * 0.65,
      lineBreak: false,
      height: 10
    });
    doc.text(`Page ${i + 1} of ${range.count}`, margin + contentWidth * 0.65, footerY, {
      width: contentWidth * 0.35,
      align: 'right',
      lineBreak: false,
      height: 10
    });
    doc.x = margin;
    doc.y = Math.min(footerY, doc.page.maxY() - 2);
  }

  doc.end();
}

function computeColumnWidths(columns, rows, contentWidth) {
  const n = columns.length || 1;
  if (!columns.length) return [contentWidth];

  const weights = columns.map((h, i) => {
    let max = String(h).length;
    for (let r = 0; r < Math.min(rows.length, 80); r++) {
      const v = rows[r] && rows[r][i] != null ? String(rows[r][i]) : '';
      max = Math.max(max, Math.min(v.length, 40));
    }
    return Math.max(max, 6);
  });
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const widths = weights.map((w) => (w / sum) * contentWidth);

  const minW = Math.min(48, contentWidth / n);
  let deficit = 0;
  const adjusted = widths.map((w) => {
    if (w < minW) {
      deficit += minW - w;
      return minW;
    }
    return w;
  });
  if (deficit > 0) {
    const flexible = adjusted.map((w, i) => (w > minW ? i : -1)).filter((i) => i >= 0);
    const flexSum = flexible.reduce((a, i) => a + adjusted[i], 0) || 1;
    flexible.forEach((i) => {
      adjusted[i] -= (adjusted[i] / flexSum) * deficit;
    });
  }

  const total = adjusted.reduce((a, b) => a + b, 0);
  if (Math.abs(total - contentWidth) > 0.5) {
    adjusted[adjusted.length - 1] += contentWidth - total;
  }
  return adjusted;
}

function pdfFilename(reportName, datePart) {
  const stamp = datePart || new Date().toISOString().split('T')[0];
  const safe = String(reportName || 'report')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${safe}-${stamp}.pdf`;
}

module.exports = {
  streamPdfReport,
  pdfFilename,
  formatINR,
  DEFAULT_LOGO
};
