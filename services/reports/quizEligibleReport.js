'use strict';

/**
 * Quiz — "Eligible users" PDF. The dashboard table (everyone who answered all 6
 * days, ranked by correct answers, then earliest completion) with the week's
 * winners on top and a plain verdict: did every winner score 6/6, and had any of
 * them won before?
 *
 * Scores are counted from the actual answers (QuizEntry) — never from the winner
 * row's saved score. No phone numbers: this report gets shared.
 */

const path = require('path');
const fs = require('fs');
const QuizWinner = require('../../models/QuizWinner');
const AuditLog = require('../../models/AuditLog');
const { computeWeekStats, lotteryPool } = require('../quizWinnerService');
const { screenPastWinners, loadPastWinnerIndex, matchPastWinner } = require('../quizPastWinnerService');
const { weekMeta, QUIZ_DAYS } = require('../../utils/quizWeek');

const isManualId = (id) => String(id || '').startsWith('manual_');

/** How a winner got on the list, from the one-time draw's audit record. */
function pickedByLabel(userId, draw) {
  if (isManualId(userId)) return 'Typed by hand';
  if (!draw || !draw.ids.has(userId)) return 'Manual page';
  return draw.mode === 'random_lottery' ? 'Lottery' : 'Admin select';
}

/** Everything the PDF shows, for one week. */
async function eligibleReportData(weekId) {
  const { participants, eligible } = await computeWeekStats(weekId);
  const ids = eligible.map((e) => e.userId);
  const [screen, winnerRows, drawLog] = await Promise.all([
    screenPastWinners(weekId, ids),
    QuizWinner.find({ weekId, isTest: { $ne: true } }).sort({ rank: 1 }).lean(),
    AuditLog.findOne({ action: 'quiz_winners_selected', entityId: weekId }).sort({ createdAt: -1 }).select('after createdAt').lean(),
  ]);
  const lottery = await lotteryPool(weekId, eligible, screen);
  const inDraw = new Set(lottery.pool.map((e) => e.userId));
  const played = new Map(participants.map((p) => [p.userId, p]));
  const after = (drawLog && drawLog.after) || {};
  const draw = drawLog ? { mode: after.mode || '', ids: new Set((after.winners || []).map((w) => w.userId)) } : null;

  // Winners who are not in the eligible list (typed by hand) are checked by phone/name.
  const outsiders = (winnerRows || []).filter((w) => !screen.has(w.userId));
  const index = outsiders.length ? await loadPastWinnerIndex(weekId) : null;

  const winnerRank = new Map();
  const winners = (winnerRows || []).map((w) => {
    winnerRank.set(w.userId, w.rank);
    const p = played.get(w.userId);
    const s = screen.get(w.userId) || (index ? matchPastWinner({ userId: w.userId, name: w.displayName, mobile: w.mobileNumber }, index) : {});
    return {
      rank: w.rank,
      name: w.displayName || (s.name) || '(unknown)',
      played: !!p,
      correct: p ? p.correct : null,
      answered: p ? p.answered : null,
      perfect: !!p && p.answered >= QUIZ_DAYS && p.correct >= QUIZ_DAYS,
      pastWin: s.pastWin || null,
      pickedBy: pickedByLabel(w.userId, draw),
    };
  });

  const rows = eligible.map((e, i) => {
    const s = screen.get(e.userId) || {};
    return {
      n: i + 1,
      name: s.name || '(unknown)',
      correct: e.correct,
      answered: e.answered,
      completedAt: e.lastSubmittedAt || null,
      perfect: e.correct >= QUIZ_DAYS,
      inDraw: inDraw.has(e.userId),
      pastWin: s.pastWin || null,
      nameMatch: s.nameMatch || null,
      winnerRank: winnerRank.get(e.userId) || null,
    };
  });

  const notPerfect = winners.filter((w) => !w.perfect);
  const wonBefore = winners.filter((w) => w.pastWin);
  return {
    weekId,
    meta: weekMeta(weekId),
    totals: {
      answeredAll: eligible.length,
      scoredPerfect: lottery.perfect,
      wonBefore: lottery.excluded.length,
      inLottery: lottery.pool.length,
      winners: winners.length,
    },
    winners,
    rows,
    verdict: {
      selected: winners.length > 0,
      allPerfect: winners.length > 0 && notPerfect.length === 0,
      notPerfect: notPerfect.map((w) => `#${w.rank} ${w.name}`),
      noneWonBefore: wonBefore.length === 0,
      wonBefore: wonBefore.map((w) => `#${w.rank} ${w.name}`),
    },
  };
}

// ───────────────────────── PDF ─────────────────────────

const RED = '#E31E24'; const INK = '#15181C'; const GREY = '#6B7280'; const LINE = '#E5E7EB'; const SOFT = '#F7F7F8';
const GREEN = '#15803D'; const GREEN_BG = '#ECFDF3'; const BAD = '#B91C1C'; const BAD_BG = '#FEF2F2'; const GOLD_BG = '#FFF7E0';

const istDate = (d, withTime = true) => new Date(d).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
  ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: true } : {}),
});
const keyDate = (k) => istDate(`${k}T12:00:00+05:30`, false);
/** "26 Sep, 05:03 AM" — short enough for its column (the year is in the header). */
function shortIst(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h12' })
    .formatToParts(new Date(d)).map((x) => [x.type, x.value]));
  return `${p.day} ${p.month}, ${p.hour}:${p.minute} ${String(p.dayPeriod || '').toUpperCase()}`;
}

/** Status cell for the full list: what this person's row means for the draw. */
function statusOf(r) {
  if (r.winnerRank) return { text: `WINNER #${r.winnerRank}`, color: INK, bold: true };
  if (r.pastWin) return { text: 'Won before', color: BAD };
  if (!r.perfect) return { text: `Not ${QUIZ_DAYS}/${QUIZ_DAYS}`, color: GREY };
  return { text: r.nameMatch ? 'In draw (same name?)' : 'In draw', color: GREEN };
}

/**
 * Draw the report. Returns the (ended) PDFDocument — pipe it before it finishes:
 * callers do `const doc = renderEligiblePdf(data); doc.pipe(res);`.
 */
function renderEligiblePdf(data, { now = new Date() } = {}) {
  const PDFDocument = require('pdfkit');
  const { registerFonts, fontFor, makeShapeSafe } = require('./subEditorWorkReport');
  const M = 40;
  const doc = new PDFDocument({ size: 'A4', margins: { top: M, left: M, right: M, bottom: 40 }, bufferPages: true, autoFirstPage: true, info: { Title: `Quiz eligible users ${data.weekId}`, Author: 'Tehelka News' } });
  const have = registerFonts(doc);
  const shapeSafe = makeShapeSafe(doc);
  const W = doc.page.width - M * 2;
  const bottom = () => doc.page.height - 48;
  const txt = (text, x, yy, { width, align = 'left', bold = false, size = 9.5, color = INK, lines = 1 } = {}) => {
    const f = fontFor(text, bold, have);
    const w = width || (doc.page.width - M - x);
    // `height` is what makes pdfkit cut with "…" rather than wrap onto the next row.
    const height = Math.ceil(size * 1.35 * lines);
    try { doc.font(f.font).fontSize(size).fillColor(color).text(shapeSafe(f.text), x, yy, { width: w, height, align, lineBreak: lines > 1, ellipsis: true }); } catch (_) {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(GREY).text(String(f.text).replace(/[^\x20-\x7E]/g, '?'), x, yy, { width: w, align, lineBreak: false });
    }
  };

  // ── Header ──
  let y = M;
  const logo = path.join(__dirname, '..', '..', 'public', 'images', 'logo.png');
  if (fs.existsSync(logo)) { try { doc.image(logo, doc.page.width / 2 - 42, y, { fit: [84, 40] }); y += 46; } catch (_) { /* no logo */ } }
  txt('QUIZ — ELIGIBLE USERS', M, y, { width: W, align: 'center', bold: true, size: 17, color: RED }); y += 24;
  txt(`Week ${keyDate(data.meta.startDate)} – ${keyDate(data.meta.endDate)}  •  Generated ${istDate(now)} IST`, M, y, { width: W, align: 'center', size: 9.5, color: GREY }); y += 16;
  doc.moveTo(M, y).lineTo(M + W, y).strokeColor(RED).lineWidth(1.5).stroke(); y += 12;

  // ── Summary tiles ──
  const tiles = [
    ['Answered all 6', data.totals.answeredAll],
    [`Scored ${QUIZ_DAYS}/${QUIZ_DAYS}`, data.totals.scoredPerfect],
    ['Won before (kept out)', data.totals.wonBefore],
    ['In the lottery', data.totals.inLottery],
    ['Winners', data.totals.winners],
  ];
  const gap = 8; const tw = (W - gap * (tiles.length - 1)) / tiles.length; const th = 46;
  tiles.forEach(([label, v], i) => {
    const x = M + i * (tw + gap);
    doc.roundedRect(x, y, tw, th, 6).fillAndStroke('#FFFFFF', LINE);
    txt(String(v), x, y + 7, { width: tw, align: 'center', bold: true, size: 17 });
    txt(label.toUpperCase(), x + 4, y + 30, { width: tw - 8, align: 'center', size: 7, color: GREY, lines: 2 });
  });
  y += th + 12;

  // ── Verdict ──
  const v = data.verdict;
  const lines = [];
  if (!v.selected) lines.push({ ok: null, t: 'Winners have not been selected for this week yet.' });
  else {
    lines.push(v.allPerfect
      ? { ok: true, t: `All ${data.winners.length} winners scored ${QUIZ_DAYS} out of ${QUIZ_DAYS} (checked from their actual answers).` }
      : { ok: false, t: `${v.notPerfect.length} winner(s) did NOT score ${QUIZ_DAYS}/${QUIZ_DAYS}: ${v.notPerfect.join(', ')}` });
    lines.push(v.noneWonBefore
      ? { ok: true, t: 'None of the winners had won in an earlier week.' }
      : { ok: false, t: `${v.wonBefore.length} winner(s) had won before: ${v.wonBefore.join(', ')}` });
  }
  const good = lines.every((l) => l.ok !== false);
  const vh = 12 + lines.length * 15;
  doc.roundedRect(M, y, W, vh, 6).fillAndStroke(good ? GREEN_BG : BAD_BG, good ? '#A7F3D0' : '#FECACA');
  lines.forEach((l, i) => {
    const colour = l.ok === false ? BAD : (l.ok ? GREEN : GREY);
    txt(`${l.ok === false ? '!' : '•'}  ${l.t}`, M + 12, y + 8 + i * 15, { width: W - 24, bold: true, size: 9.5, color: colour });
  });
  y += vh + 16;

  // ── Tables ──
  function table(title, note, cols, items, rowStyle) {
    const rowH = 19; const headH = 22;
    const head = () => {
      doc.rect(M, y, W, headH).fill('#F3F4F6');
      let x = M; cols.forEach((c) => { txt(c.label, x + 5, y + 7, { width: c.w - 10, align: c.align, bold: true, size: 8.5 }); x += c.w; });
      y += headH;
    };
    if (y + 40 + headH + rowH > bottom()) { doc.addPage(); y = M; }
    txt(title, M, y, { bold: true, size: 11.5 }); y += 16;
    if (note) { txt(note, M, y, { size: 8, color: GREY }); y += 13; }
    head();
    items.forEach((it, i) => {
      if (y + rowH > bottom()) { doc.addPage(); y = M; head(); }
      const st = rowStyle(it);
      if (st.bg) doc.rect(M, y, W, rowH).fill(st.bg); else if (i % 2 === 1) doc.rect(M, y, W, rowH).fill(SOFT);
      let x = M;
      cols.forEach((c) => {
        const cell = c.cell(it);
        const o = typeof cell === 'object' && cell !== null ? cell : { text: cell };
        txt(String(o.text == null ? '' : o.text), x + 5, y + 5.5, { width: c.w - 10, align: c.align, bold: !!o.bold, size: c.size || 9, color: o.color || st.color || INK });
        x += c.w;
      });
      doc.moveTo(M, y + rowH).lineTo(M + W, y + rowH).strokeColor(LINE).lineWidth(0.5).stroke();
      y += rowH;
    });
    y += 16;
  }

  if (data.winners.length) {
    const yes = (ok) => ({ text: ok ? 'Yes' : 'NO', color: ok ? GREEN : BAD, bold: true });
    table("THIS WEEK'S WINNERS", 'Score counted from their actual answers this week.', [
      { label: 'Rank', w: 40, align: 'center', cell: (w) => ({ text: w.rank, bold: true }) },
      { label: 'Name', w: 190, cell: (w) => ({ text: w.name, bold: true }) },
      { label: 'Score', w: 60, align: 'center', cell: (w) => (w.played ? `${w.correct} / ${w.answered}` : '—') },
      { label: `${QUIZ_DAYS}/${QUIZ_DAYS}?`, w: 50, align: 'center', cell: (w) => (w.played ? yes(w.perfect) : { text: 'Not a player', color: BAD, bold: true }) },
      { label: 'Won before?', w: 90, align: 'center', cell: (w) => (w.pastWin ? { text: `Yes — ${w.pastWin.weekId}`, color: BAD, bold: true } : { text: 'No', color: GREEN, bold: true }) },
      { label: 'Picked by', w: W - 430, align: 'center', cell: (w) => w.pickedBy },
    ], data.winners, () => ({ bg: GOLD_BG }));
  }

  table('ALL ELIGIBLE USERS — answered all 6, ranked by correct, then earliest completion',
    `In draw = ${QUIZ_DAYS}/${QUIZ_DAYS} and never won before  •  Won before = kept out of the lottery  •  Not ${QUIZ_DAYS}/${QUIZ_DAYS} = not in the lottery`, [
      { label: '#', w: 30, align: 'center', cell: (r) => r.n },
      { label: 'Name', w: 190, cell: (r) => ({ text: r.name, bold: !!r.winnerRank }) },
      { label: 'Correct', w: 55, align: 'center', cell: (r) => ({ text: r.correct, bold: true }) },
      { label: 'Answered', w: 60, align: 'center', cell: (r) => r.answered },
      { label: 'Completed (IST)', w: 100, cell: (r) => (r.completedAt ? shortIst(r.completedAt) : '—'), size: 8.5 },
      { label: 'Status', w: W - 435, cell: (r) => statusOf(r), size: 8.5 },
    ], data.rows, (r) => (r.winnerRank ? { bg: GOLD_BG } : (!r.perfect ? { color: GREY } : {})));

  if (!data.rows.length) { txt('No one answered all 6 questions this week.', M, y, { size: 10, color: GREY }); }

  // ── Footer on every page ──
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // writing inside the bottom margin must not open a new page
    const fy = doc.page.height - 30;
    doc.font('Helvetica').fontSize(7.5).fillColor(GREY)
      .text(`Tehelka News • Quiz eligible users • week ${data.weekId} • Confidential — internal record`, M, fy, { width: W - 70, lineBreak: false });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, doc.page.width - M - 70, fy, { width: 70, align: 'right', lineBreak: false });
  }
  doc.end();
  return doc;
}

module.exports = { eligibleReportData, renderEligiblePdf, pickedByLabel, statusOf, shortIst };
