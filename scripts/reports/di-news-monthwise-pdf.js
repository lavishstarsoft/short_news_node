'use strict';

/**
 * District In-charges of a state → PDF with: promotion date (to DI) + month-wise
 * news counts (matrix) + total. For verifying who was promoted when and their
 * actual output. READ-ONLY. Landscape A4.
 * Usage: node scripts/reports/di-news-monthwise-pdf.js "Tamil Nadu"
 */
require('dotenv').config();
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const mongoose = require('mongoose');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FONT = path.join(__dirname, '../../assets/fonts/NotoSansTelugu-Regular.ttf');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
const mLabel = (k) => { const [y, m] = k.split('-'); return `${['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m]} '${y.slice(2)}`; };

async function main() {
  const STATE = (process.argv[2] || 'Tamil Nadu').trim();
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const A = db.collection('admins');
  const N = db.collection('news');
  const AL = db.collection('auditlogs');

  const dis = await A.find({ reporterTier: 'district_incharge', assignedState: STATE })
    .project({ name: 1, username: 1, mobileNumber: 1, assignedDistricts: 1, createdAt: 1 }).toArray();
  if (!dis.length) { console.log('None.'); return process.exit(0); }
  dis.sort((a, b) => String((a.assignedDistricts || [])[0] || '').localeCompare(String((b.assignedDistricts || [])[0] || '')));

  const idStr = dis.map((d) => String(d._id));
  const idObj = dis.map((d) => d._id);

  // "DI since" date. Individual promotions were not always logged as
  // reporter_tier_change (many were bulk-set), so we take the best available signal:
  //   1) reporter_tier_change → district_incharge  (explicit promotion)
  //   2) else earliest wallet_config_update targeting them (their tier/wallet was set up)
  //   3) else the account join date (createdAt).
  const promo = {}; const promoSrc = {};
  const plogs = await AL.find({ action: 'reporter_tier_change', targetId: { $in: idObj }, 'after.reporterTier': 'district_incharge' })
    .project({ targetId: 1, createdAt: 1 }).sort({ createdAt: 1 }).toArray();
  plogs.forEach((l) => { promo[String(l.targetId)] = l.createdAt; promoSrc[String(l.targetId)] = 'promoted'; });
  const wlogs = await AL.aggregate([
    { $match: { action: 'wallet_config_update', targetId: { $in: idObj } } },
    { $group: { _id: '$targetId', first: { $min: '$createdAt' } } },
  ]).toArray();
  wlogs.forEach((l) => { const k = String(l._id); if (!promo[k]) { promo[k] = l.first; promoSrc[k] = 'tierset'; } });
  dis.forEach((d) => { const k = String(d._id); if (!promo[k]) { promo[k] = d.createdAt; promoSrc[k] = 'joined'; } });

  // Month-wise news counts by author.
  const agg = await N.aggregate([
    { $match: { authorId: { $in: idStr } } },
    { $group: { _id: { a: '$authorId', mth: { $dateToString: { format: '%Y-%m', date: '$publishedAt' } } }, c: { $sum: 1 } } },
  ]).toArray();
  const byAuthor = {}; const monthsSet = new Set();
  const totals = {};
  agg.forEach((r) => {
    const a = r._id.a; const mth = r._id.mth || 'NA';
    byAuthor[a] = byAuthor[a] || {};
    byAuthor[a][mth] = (byAuthor[a][mth] || 0) + r.c;
    totals[a] = (totals[a] || 0) + r.c;
    if (mth !== 'NA') monthsSet.add(mth);
  });
  const months = [...monthsSet].sort();

  const thMonths = months.map((k) => `<th class="c">${mLabel(k)}</th>`).join('');
  const rows = dis.map((d, i) => {
    const a = String(d._id);
    const cells = months.map((k) => { const v = (byAuthor[a] || {})[k] || 0; return `<td class="c ${v ? '' : 'z'}">${v || '·'}</td>`; }).join('');
    const na = (byAuthor[a] || {}).NA || 0;
    return `<tr>
      <td class="c">${i + 1}</td>
      <td><b>${esc(d.name || d.username || '-')}</b></td>
      <td class="mob">${esc(d.mobileNumber || '-')}</td>
      <td>${esc((d.assignedDistricts || []).join(', ') || '-')}</td>
      <td class="c">${fmt(promo[a])}<div class="src">${promoSrc[a] === 'promoted' ? 'promoted' : (promoSrc[a] === 'tierset' ? 'tier set' : 'joined')}</div></td>
      ${cells}
      <td class="c tot">${totals[a] || 0}${na ? `<sup>+${na}</sup>` : ''}</td>
    </tr>`;
  }).join('');

  const grand = Object.values(totals).reduce((s, v) => s + v, 0);

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @page { size: A4 landscape; margin: 10mm; }
    @font-face { font-family:'NotoTe'; src:url('file://${FONT}'); }
    *{box-sizing:border-box;}
    body{font-family:'NotoTe','Noto Sans Telugu',sans-serif;margin:0;color:#111827;font-size:10.5px;}
    .hdr{background:#5E35B1;color:#fff;padding:12px 16px;border-radius:8px;margin-bottom:10px;}
    .hdr h1{margin:0;font-size:16px;} .hdr p{margin:3px 0 0;font-size:10px;opacity:.9;}
    table{width:100%;border-collapse:collapse;}
    th{background:#0f172a;color:#fff;padding:6px 5px;font-size:9.5px;text-align:left;}
    td{padding:5px;border-bottom:1px solid #eef0f4;}
    tr:nth-child(even) td{background:#faf9fe;}
    .c{text-align:center;} .mob{white-space:nowrap;} .z{color:#cbd5e1;}
    .tot{font-weight:800;color:#5E35B1;} .tot sup{color:#9aa0ae;font-weight:600;}
    .src{font-size:8px;color:#9aa0ae;margin-top:1px;}
    .note{font-size:9.5px;color:#6b7280;margin-top:8px;}
  </style></head><body>
    <div class="hdr"><h1>TEHELKA NEWS — ${esc(STATE)} District In-charges · Promotion & Month-wise News</h1>
      <p>Total ${dis.length} DIs &nbsp;•&nbsp; Grand total news: <b>${grand}</b> &nbsp;•&nbsp; ${new Date().toLocaleDateString('en-IN')}</p></div>
    <table>
      <thead><tr><th>#</th><th>Name</th><th>Mobile</th><th>District</th><th class="c">Promoted (DI)</th>${thMonths}<th class="c">Total</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="note">• Numbers = news posted that month (by publish date). "·" = none. <sup>+n</sup> in Total = news with no publish date. • "Promoted (DI)" date source shown under it: <b>promoted</b> = explicit tier-change log · <b>tier set</b> = first wallet/tier setup (best proxy) · <b>joined</b> = account created (no tier log found).</div>
  </body></html>`;

  const htmlPath = path.join(os.tmpdir(), `dinews_${Date.now()}.html`);
  const OUT = path.join(os.homedir(), 'Desktop', `DI_News_Monthwise_${STATE.replace(/\s+/g, '_')}.pdf`);
  fs.writeFileSync(htmlPath, html, 'utf8');
  console.log(`${STATE}: ${dis.length} DIs, months ${months.join(',')}, grand ${grand}`);
  await mongoose.disconnect();
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${OUT}`, `file://${htmlPath}`], { stdio: 'ignore' });
  try { fs.unlinkSync(htmlPath); } catch (_) {}
  console.log('PDF: ' + OUT);
}
main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
