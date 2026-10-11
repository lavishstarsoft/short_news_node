'use strict';

/**
 * Sub-Editor PERFORMANCE report — the clean one-glance PDF (logo, one table
 * with every metric + a 24h timeline + a performance score per sub editor,
 * grand total, insights). Works on the rows produced by subEditorWorkReport.
 *
 * Score (0–100, printed in the legend so it is never a black box):
 *   Volume     30  posted ÷ team target (75th percentile of the team's posts, min 20)
 *   Quality    35  falls to 0 when 50% of posts are AI-duplicate flagged
 *   Discipline 20  falls to 0 when 50% of posts are rejected / sent back
 *   Speed      15  avg submit→publish ≤ 15 min = full; 0 at ≥ 120 min
 *   Penalty   −5   per deleted article (max −15)
 * Grade: A+ ≥ 90, A ≥ 80, B ≥ 70, C ≥ 60, D < 60.
 */

const fs = require('fs');
const path = require('path');
const { fontFor, makeShapeSafe, registerFonts, makeReportId, fmtIST } = require('./subEditorWorkReport');

const SCORE = { VOLUME: 30, QUALITY: 35, DISCIPLINE: 20, SPEED: 15, DELETE_PENALTY: 5, DELETE_PENALTY_MAX: 15, TARGET_MIN: 20 };

function gradeOf(total) {
  return total >= 90 ? 'A+' : total >= 80 ? 'A' : total >= 70 ? 'B' : total >= 60 ? 'C' : 'D';
}

/** Adds score/grade/scoreParts to every row (mutates + returns rows). */
function computeScores(rows) {
  const posted = rows.filter((r) => r.posted > 0).map((r) => r.posted).sort((a, b) => a - b);
  const p75 = posted.length ? posted[Math.min(posted.length - 1, Math.floor(posted.length * 0.75))] : 0;
  const target = Math.max(SCORE.TARGET_MIN, p75);
  for (const r of rows) {
    r.scoreTarget = target;
    if (!r.posted) { r.score = 0; r.grade = '—'; r.scoreParts = { volume: 0, quality: 0, discipline: 0, speed: 0, penalty: 0 }; continue; }
    const volume = Math.min(1, r.posted / target) * SCORE.VOLUME;
    const quality = Math.max(0, 1 - (r.aiFlagged / r.posted) * 2) * SCORE.QUALITY;
    const discipline = Math.max(0, 1 - ((r.rejected + r.sentBack) / r.posted) * 2) * SCORE.DISCIPLINE;
    const speed = r.avgPublishMinutes == null ? SCORE.SPEED : Math.max(0, 1 - Math.max(0, r.avgPublishMinutes - 15) / 105) * SCORE.SPEED;
    const penalty = Math.min(SCORE.DELETE_PENALTY_MAX, r.deleted * SCORE.DELETE_PENALTY);
    const total = Math.max(0, Math.min(100, Math.round(volume + quality + discipline + speed - penalty)));
    r.scoreParts = { volume: Math.round(volume), quality: Math.round(quality), discipline: Math.round(discipline), speed: Math.round(speed), penalty };
    r.score = total;
    r.grade = gradeOf(total);
  }
  return rows;
}

const BLUE = '#0D6EFD'; const INK = '#1F2937'; const GREY = '#6B7280'; const LINE = '#DEE2E6';
const GREEN = '#198754'; const PURPLE = '#6F42C1'; const AMBER = '#D97706'; const REDC = '#DC3545'; const PINK = '#BE185D';
const PAGE = { w: 841.89, h: 595.28, m: 34 };

function gradeColor(g) { return g === 'A+' || g === 'A' ? GREEN : g === 'B' ? BLUE : g === 'C' ? AMBER : g === 'D' ? REDC : GREY; }

function buildPerformancePdf({ rows, totals, period, selectedIds, generatedBy = 'Super Admin', logoPath, now = new Date(), PDFDocument = require('pdfkit') }) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margins: { top: PAGE.m, left: PAGE.m, right: PAGE.m, bottom: 0 }, bufferPages: true, info: { Title: 'Sub-Editor Performance Report', Author: 'Tehelka News' } });
  const have = registerFonts(doc);
  const shapeSafe = makeShapeSafe(doc);
  const reportId = makeReportId(now);
  const W = PAGE.w - PAGE.m * 2;
  const sel = new Set((selectedIds || []).map(String));
  const list = rows.filter((r) => sel.size === 0 || sel.has(String(r.authorId)));
  const wsafe = (s) => { try { return doc.widthOfString(s); } catch (_) { return Infinity; } };
  const fit = (s, w) => {
    if (wsafe(s) <= w) return s;
    let out = '';
    for (const part of s.split(/(\s+)/)) { if (wsafe(out + part + '…') > w) break; out += part; }
    if (!out.trim()) { let lo = 0; let hi = s.length; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (wsafe(s.slice(0, mid) + '…') <= w) lo = mid; else hi = mid - 1; } out = s.slice(0, lo); }
    return out.replace(/\s+$/, '') + '…';
  };
  const txt = (text, x, yy, { width, align = 'left', bold = false, size = 9, color = INK } = {}) => {
    const f = fontFor(text, bold, have);
    const w = width || (PAGE.w - PAGE.m - x);
    try { doc.font(f.font).fontSize(size).fillColor(color); doc.text(fit(shapeSafe(f.text), w), x, yy, { width: w, align, lineBreak: false }); }
    catch (_) { doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(GREY).text('[unprintable]', x, yy, { width: w, align, lineBreak: false }); }
  };
  let y = PAGE.m;
  const newPage = () => { doc.addPage(); y = PAGE.m; };
  const ensure = (need) => { if (y + need > PAGE.h - 34) newPage(); };

  // ---- Header: logo + title + date range + rule
  if (logoPath && fs.existsSync(logoPath)) {
    try { doc.image(logoPath, PAGE.w / 2 - 60, y, { fit: [120, 58], align: 'center' }); y += 64; } catch (_) { y += 4; }
  }
  doc.font('Helvetica-Bold').fontSize(20).fillColor(BLUE).text('SUB-EDITOR PERFORMANCE REPORT', PAGE.m, y, { width: W, align: 'center' }); y += 28;
  {
    const label = 'Date Range: ';
    const value = `${period.fromStr} to ${period.toStr}` + (period.days > 1 ? `  (${period.days} days)` : '');
    doc.font('Helvetica-Bold').fontSize(10); const w1 = doc.widthOfString(label);
    doc.font('Helvetica').fontSize(10); const w2 = doc.widthOfString(value);
    const x0 = PAGE.m + (W - w1 - w2) / 2;
    doc.font('Helvetica-Bold').fillColor(INK).text(label, x0, y, { lineBreak: false });
    doc.font('Helvetica').fillColor(INK).text(value, x0 + w1, y, { lineBreak: false });
    y += 14;
  }
  doc.font('Helvetica').fontSize(8).fillColor(GREY).text(`${list.length} sub editor${list.length === 1 ? '' : 's'} selected  •  Report ID ${reportId}  •  Generated ${fmtIST(now)} by ${generatedBy}`, PAGE.m, y, { width: W, align: 'center' });
  y += 14;
  doc.moveTo(PAGE.m, y).lineTo(PAGE.m + W, y).strokeColor(BLUE).lineWidth(1.5).stroke(); y += 12;

  // ---- Main table
  const langsAll = {};
  list.forEach((r) => Object.entries(r.byLanguage || {}).forEach(([l, n]) => { langsAll[l] = (langsAll[l] || 0) + n; }));
  const langs = Object.entries(langsAll).sort((a, b) => b[1] - a[1]).map(([l]) => l).slice(0, 4);
  const cols = [
    { key: 'name', label: 'Name & Role', w: 118, align: 'left' },
    { key: 'posted', label: 'Total', w: 36, color: BLUE, bold: true },
    { key: 'normal', label: 'Normal', w: 40, color: GREEN },
    { key: 'video', label: 'Video', w: 36, color: PURPLE },
    ...langs.map((l) => ({ key: 'L_' + l, label: l.charAt(0).toUpperCase() + l.slice(1), w: 32, color: BLUE, bold: true, shade: true })),
    { key: 'published', label: 'Publ.', w: 36, color: GREEN },
    { key: 'pendingNow', label: 'Pend.', w: 34, color: AMBER },
    { key: 'aiFlagged', label: 'AI dup', w: 38, color: PINK },
    { key: 'publishedAnyway', label: 'Pub.any', w: 42, color: PINK },
    { key: 'rejected', label: 'Rej.', w: 32, color: REDC },
    { key: 'edited', label: 'Edited', w: 36, color: BLUE },
    { key: 'deleted', label: 'Deleted', w: 40, color: REDC },
    { key: 'views', label: 'Views', w: 40, color: INK },
    { key: 'avgPub', label: 'Avg>pub', w: 44, color: INK },
    { key: 'timeline', label: '24h Timeline', w: 96 },
    { key: 'score', label: 'Score', w: 52 },
  ];
  const totalW = cols.reduce((s, c) => s + c.w, 0);
  const scale = Math.min(1, W / totalW);
  cols.forEach((c) => { c.w = Math.floor(c.w * scale); });
  const tableW = cols.reduce((s, c) => s + c.w, 0);
  const rowH = 34; const headH = 24;

  const drawHead = () => {
    doc.rect(PAGE.m, y, tableW, headH).fillAndStroke('#F8F9FA', LINE);
    let x = PAGE.m;
    cols.forEach((c) => {
      if (c.shade) doc.rect(x, y, c.w, headH).fillAndStroke('#E7F1FF', LINE);
      txt(c.label, x + 3, y + 8, { width: c.w - 6, align: c.key === 'name' ? 'left' : 'center', bold: true, size: 8, color: INK });
      x += c.w;
    });
    y += headH;
  };
  const timeline = (x, yy, w, h, hours) => {
    const max = Math.max(1, ...hours);
    const bw = w / 24;
    for (let i = 0; i < 24; i++) {
      const v = hours[i] || 0;
      const shade = v === 0 ? '#E5E7EB' : v >= max * 0.66 ? '#15803D' : v >= max * 0.33 ? '#22C55E' : '#86EFAC';
      doc.rect(x + i * bw + 0.6, yy, bw - 1.2, h).fill(shade);
    }
  };
  const drawRow = (r, i) => {
    if (y + rowH > PAGE.h - 34) { newPage(); drawHead(); }
    if (i % 2 === 1) doc.rect(PAGE.m, y, tableW, rowH).fill('#FBFBFC');
    doc.rect(PAGE.m, y, tableW, rowH).strokeColor(LINE).lineWidth(0.6).stroke();
    let x = PAGE.m;
    const vals = {
      name: r.name, posted: r.posted, normal: r.posted - (r.video || 0), video: r.video || 0, published: r.published, pendingNow: r.pendingNow,
      aiFlagged: r.aiFlagged, publishedAnyway: r.publishedAnyway, rejected: r.rejected, edited: r.edited, deleted: r.deleted, views: r.views,
      avgPub: r.avgPublishMinutes == null ? '—' : r.avgPublishMinutes + 'm',
    };
    langs.forEach((l) => { vals['L_' + l] = (r.byLanguage && r.byLanguage[l]) || 0; });
    cols.forEach((c) => {
      if (c.shade) doc.rect(x, y, c.w, rowH).fill('#F3F8FF');
      if (c.key === 'name') {
        txt(r.name, x + 6, y + 6, { width: c.w - 10, bold: true, size: 9.5 });
        txt(r.isActive ? 'Sub editor' : 'Sub editor (inactive)', x + 6, y + 20, { width: c.w - 10, size: 7.5, color: GREY });
      } else if (c.key === 'timeline') {
        timeline(x + 4, y + 11, c.w - 8, 12, r.hours || []);
      } else if (c.key === 'score') {
        const g = r.grade || '—'; const col = gradeColor(g);
        doc.roundedRect(x + 5, y + 6, c.w - 10, 22, 5).fill(col);
        txt(r.posted ? `${r.score}` : '—', x + 5, y + 9, { width: c.w - 10, align: 'center', bold: true, size: 11, color: '#FFFFFF' });
        txt(r.posted ? g : '', x + 5, y + 21, { width: c.w - 10, align: 'center', bold: true, size: 6.5, color: '#FFFFFF' });
      } else {
        const v = vals[c.key];
        const zeroGrey = v === 0 || v === '—';
        txt(String(v), x + 2, y + 11, { width: c.w - 4, align: 'center', bold: !!c.bold, size: 10, color: zeroGrey ? '#9CA3AF' : c.color || INK });
      }
      x += c.w;
    });
    y += rowH;
  };

  ensure(headH + rowH * 2);
  drawHead();
  list.forEach(drawRow);

  // grand total
  const t = list.reduce((acc, r) => {
    ['posted', 'video', 'published', 'pendingNow', 'aiFlagged', 'publishedAnyway', 'rejected', 'edited', 'deleted', 'views'].forEach((k) => { acc[k] = (acc[k] || 0) + (r[k] || 0); });
    Object.entries(r.byLanguage || {}).forEach(([l, n]) => { acc.byLanguage[l] = (acc.byLanguage[l] || 0) + n; });
    (r.hours || []).forEach((v, i) => { acc.hours[i] += v; });
    return acc;
  }, { byLanguage: {}, hours: new Array(24).fill(0) });
  if (y + rowH > PAGE.h - 34) { newPage(); drawHead(); }
  doc.rect(PAGE.m, y, tableW, rowH).fillAndStroke('#F1F3F5', LINE);
  {
    let x = PAGE.m;
    const scored = list.filter((r) => r.posted > 0);
    const avgScore = scored.length ? Math.round(scored.reduce((s, r) => s + r.score, 0) / scored.length) : null;
    const tv = { name: 'GRAND TOTAL', posted: t.posted, normal: t.posted - t.video, video: t.video, published: t.published, pendingNow: t.pendingNow, aiFlagged: t.aiFlagged, publishedAnyway: t.publishedAnyway, rejected: t.rejected, edited: t.edited, deleted: t.deleted, views: t.views, avgPub: '—' };
    langs.forEach((l) => { tv['L_' + l] = t.byLanguage[l] || 0; });
    cols.forEach((c) => {
      if (c.key === 'name') txt('GRAND TOTAL', x + 6, y + 11, { width: c.w - 10, align: 'right', bold: true, size: 10.5 });
      else if (c.key === 'timeline') timeline(x + 4, y + 11, c.w - 8, 12, t.hours);
      else if (c.key === 'score') txt(avgScore == null ? '—' : `avg ${avgScore}`, x + 2, y + 12, { width: c.w - 4, align: 'center', bold: true, size: 9, color: avgScore == null ? GREY : gradeColor(gradeOf(avgScore)) });
      else txt(String(tv[c.key]), x + 2, y + 11, { width: c.w - 4, align: 'center', bold: true, size: 10.5, color: c.color || INK });
      x += c.w;
    });
    y += rowH + 14;
  }

  // ---- Score breakdown table
  const scoredList = list.filter((r) => r.posted > 0).sort((a, b) => b.score - a.score);
  if (scoredList.length) {
    // keep the heading with its table (small tables never split from the title)
    ensure(scoredList.length <= 14 ? 18 * (scoredList.length + 1) + 50 : 60);
    doc.font('Helvetica-Bold').fontSize(12).fillColor(BLUE).text('Performance score breakdown', PAGE.m, y); y += 18;
    const bc = [{ k: 'rank', l: '#', w: 26 }, { k: 'name', l: 'Sub editor', w: 150, left: true }, { k: 'volume', l: `Volume /${SCORE.VOLUME}`, w: 70 }, { k: 'quality', l: `Quality /${SCORE.QUALITY}`, w: 70 }, { k: 'discipline', l: `Discipline /${SCORE.DISCIPLINE}`, w: 80 }, { k: 'speed', l: `Speed /${SCORE.SPEED}`, w: 64 }, { k: 'penalty', l: 'Delete penalty', w: 76 }, { k: 'score', l: 'Total /100', w: 64 }, { k: 'grade', l: 'Grade', w: 50 }, { k: 'dup', l: 'Dup %', w: 50 }, { k: 'note', l: 'Remark', w: 170, left: true }];
    const bw = bc.reduce((s, c) => s + c.w, 0);
    const bh = 18;
    const head = () => { doc.rect(PAGE.m, y, bw, bh).fillAndStroke('#F8F9FA', LINE); let x = PAGE.m; bc.forEach((c) => { txt(c.l, x + 3, y + 5, { width: c.w - 6, align: c.left ? 'left' : 'center', bold: true, size: 8 }); x += c.w; }); y += bh; };
    head();
    scoredList.forEach((r, i) => {
      if (y + bh > PAGE.h - 34) { newPage(); head(); }
      if (i % 2 === 1) doc.rect(PAGE.m, y, bw, bh).fill('#FBFBFC');
      doc.rect(PAGE.m, y, bw, bh).strokeColor(LINE).lineWidth(0.5).stroke();
      const p = r.scoreParts; const dup = Math.round((r.aiFlagged / r.posted) * 100);
      const remark = r.deleted ? `${r.deleted} deleted` : dup >= 30 ? 'High duplicate rate' : r.posted < r.scoreTarget / 2 ? 'Low volume' : r.score >= 90 ? 'Excellent' : r.score >= 80 ? 'Good' : 'Needs improvement';
      const vals = { rank: i + 1, name: r.name, volume: p.volume, quality: p.quality, discipline: p.discipline, speed: p.speed, penalty: p.penalty ? `-${p.penalty}` : '0', score: r.score, grade: r.grade, dup: dup + '%', note: remark };
      let x = PAGE.m;
      bc.forEach((c) => { txt(String(vals[c.k]), x + 3, y + 5, { width: c.w - 6, align: c.left ? 'left' : 'center', bold: c.k === 'score' || c.k === 'grade' || c.k === 'name', size: 8.5, color: c.k === 'grade' || c.k === 'score' ? gradeColor(r.grade) : c.k === 'dup' && dup >= 30 ? REDC : INK }); x += c.w; });
      y += bh;
    });
    y += 12;
  }

  // ---- Overall insights
  const peakHour = t.hours.indexOf(Math.max(...t.hours));
  const fmtH = (h) => `${((h + 11) % 12) + 1}:00 ${h < 12 ? 'AM' : 'PM'}`;
  const best = scoredList[0]; const most = [...list].sort((a, b) => b.posted - a.posted)[0];
  const zero = list.filter((r) => r.posted === 0).map((r) => r.name);
  const highDup = list.filter((r) => r.posted && r.aiFlagged / r.posted >= 0.3).map((r) => `${r.name} (${Math.round((r.aiFlagged / r.posted) * 100)}%)`);
  const langLine = Object.entries(t.byLanguage).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l.toUpperCase()} ${n}`).join(', ');
  const insights = [];
  if (t.posted) insights.push(['Peak Activity Time', `The most active period was between ${fmtH(peakHour)} and ${fmtH((peakHour + 1) % 24)}, during which the selected team posted ${t.hours[peakHour]} articles.`]);
  if (best) insights.push(['Top Performer', `${best.name} — score ${best.score} (${best.grade}), ${best.posted} posts, ${Math.round((best.aiFlagged / best.posted) * 100)}% duplicate rate.`]);
  if (most && most !== best && most.posted) insights.push(['Most Posts', `${most.name} posted the most articles (${most.posted}).`]);
  if (langLine) insights.push(['Language Split', langLine + '.']);
  if (highDup.length) insights.push(['Quality Warning', `Duplicate rate of 30% or more: ${highDup.join(', ')}.`]);
  if (t.deleted) insights.push(['Deleted', `${t.deleted} article${t.deleted === 1 ? '' : 's'} deleted by the desk in this period.`]);
  if (zero.length) insights.push(['No Activity', `${zero.join(', ')} posted nothing in this period.`]);
  if (!insights.length) insights.push(['No Activity', 'No articles were posted by the selected sub editors in this period.']);

  const lines = insights.map(([k, v]) => ({ k, v }));
  let boxH = 30;
  doc.font('Helvetica').fontSize(9.5);
  lines.forEach((l) => { boxH += doc.heightOfString(`${l.k}: ${l.v}`, { width: W - 40 }) + 5; });
  ensure(boxH + 10);
  doc.rect(PAGE.m, y, W, boxH).fill('#F8F9FA');
  doc.rect(PAGE.m, y, 4, boxH).fill(BLUE);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(BLUE).text('Overall Insights', PAGE.m + 16, y + 9);
  let iy = y + 28;
  lines.forEach((l) => {
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(`${l.k}: `, PAGE.m + 16, iy, { width: W - 40, continued: true });
    const f = fontFor(l.v, false, have); doc.font(f.font).fillColor(INK).text(shapeSafe(f.text), { width: W - 40 });
    iy += doc.heightOfString(`${l.k}: ${l.v}`, { width: W - 40 }) + 5;
  });
  y += boxH + 12;

  // ---- Score legend
  const legend = `How the score works (0-100): Volume ${SCORE.VOLUME} pts = posts / team target (${list[0] ? list[0].scoreTarget : SCORE.TARGET_MIN} posts = the 75th percentile of all sub editors in this period, min ${SCORE.TARGET_MIN}) • Quality ${SCORE.QUALITY} pts = falls to 0 when 50% of posts are AI-duplicate flagged • Discipline ${SCORE.DISCIPLINE} pts = falls to 0 when 50% of posts are rejected or sent back • Speed ${SCORE.SPEED} pts = average submit-to-publish time of 15 min or less is full, 0 at 120 min (self-published = full) • minus ${SCORE.DELETE_PENALTY} per deleted article (max minus ${SCORE.DELETE_PENALTY_MAX}). Grades: A+ 90 and above, A 80-89, B 70-79, C 60-69, D below 60. Timeline: 24 bars = hours 0-23 IST, darker = more posts.`;
  doc.font('Helvetica').fontSize(7.5);
  const lh = doc.heightOfString(legend, { width: W });
  ensure(lh + 10);
  doc.fillColor(GREY).text(legend, PAGE.m, y, { width: W });
  y += lh + 10;

  // ---- Footer on every page
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.moveTo(PAGE.m, PAGE.h - 30).lineTo(PAGE.m + W, PAGE.h - 30).strokeColor(LINE).lineWidth(0.6).stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor(GREY).text(`Generated automatically by Tehelka News Admin Panel on ${fmtIST(now, false)}  •  ${reportId}  •  Confidential — internal record`, PAGE.m, PAGE.h - 22, { width: W - 80, lineBreak: false });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, PAGE.w - PAGE.m - 80, PAGE.h - 22, { width: 80, align: 'right' });
  }
  return { doc, reportId, selected: list.length };
}

module.exports = { computeScores, buildPerformancePdf, gradeOf, SCORE };
