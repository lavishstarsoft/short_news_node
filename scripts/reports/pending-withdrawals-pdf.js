'use strict';

/**
 * Pending withdrawal requests → PDF, filtered by state(s). Renders via headless
 * Google Chrome (Telugu-safe). READ-ONLY.
 * Usage: node scripts/reports/pending-withdrawals-pdf.js ["Tamil Nadu,Andhra Pradesh,Telangana"]
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
const fmtJoin = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
const fmtReq = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }) : '-');

async function main() {
  const wanted = (process.argv[2] || 'Tamil Nadu,Andhra Pradesh,Telangana').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const exclude = String(process.argv[3] || '').toLowerCase() === 'exclude'; // list everyone EXCEPT `wanted`
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const pend = await db.collection('withdrawalrequests').find({ status: 'pending' }).toArray();
  const ids = [...new Set(pend.map((p) => String(p.adminId)))].map((id) => { try { return new mongoose.Types.ObjectId(id); } catch (_) { return null; } }).filter(Boolean);
  const admins = await db.collection('admins').find({ _id: { $in: ids } }).project({ name: 1, username: 1, mobileNumber: 1, phone: 1, assignedState: 1, assignedDistrict: 1, reporterTier: 1, createdAt: 1 }).toArray();
  const map = {}; admins.forEach((a) => { map[String(a._id)] = a; });

  let rows = pend.filter((p) => {
    const inSet = wanted.includes(String((map[String(p.adminId)] || {}).assignedState || '').trim().toLowerCase());
    return exclude ? !inSet : inSet;
  });
  rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const byState = {}; rows.forEach((p) => { const s = (map[String(p.adminId)] || {}).assignedState || '?'; byState[s] = (byState[s] || 0) + 1; });
  const total = rows.reduce((s, p) => s + (p.amount || 0), 0);
  console.log(`Matched pending: ${rows.length} — ${JSON.stringify(byState)}`);
  if (!rows.length) { console.log('None.'); return process.exit(0); }

  const trs = rows.map((p, i) => {
    const a = map[String(p.adminId)] || {};
    const type = a.reporterTier === 'district_incharge' ? 'DI' : (a.reporterTier === 'stringer' ? 'Stringer' : '-');
    return `<tr>
      <td class="c">${i + 1}</td>
      <td><b>${esc(a.name || a.username || '-')}</b><div class="sub">${esc(a.mobileNumber || a.phone || '-')}</div></td>
      <td>${esc(a.assignedState || '-')}</td>
      <td>${fmtJoin(a.createdAt)}</td>
      <td class="amt">₹${(p.amount || 0).toLocaleString('en-IN')}</td>
      <td class="pay">${esc(p.paymentDetails || '-')}</td>
      <td class="c"><span class="tag ${type === 'DI' ? 'di' : 'st'}">${type}</span></td>
      <td class="c"><span class="pend">PENDING</span></td>
      <td>${fmtReq(p.createdAt)}<div class="sub">${esc(p.utr || '')}</div></td>
    </tr>`;
  }).join('');

  const chips = Object.entries(byState).map(([s, c]) => `${esc(s)}: <b>${c}</b>`).join(' &nbsp;•&nbsp; ');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @font-face { font-family:'NotoTe'; src:url('file://${FONT}'); }
    *{box-sizing:border-box;}
    body{font-family:'NotoTe','Noto Sans Telugu',sans-serif;margin:0;color:#111827;font-size:11px;}
    .hdr{background:#1FA363;color:#fff;padding:14px 18px;}
    .hdr h1{margin:0;font-size:17px;} .hdr p{margin:4px 0 0;font-size:11px;opacity:.9;}
    .wrap{padding:12px 16px;}
    table{width:100%;border-collapse:collapse;}
    th{background:#0f172a;color:#fff;text-align:left;padding:7px 8px;font-size:10px;}
    td{padding:7px 8px;border-bottom:1px solid #eef0f4;vertical-align:top;}
    tr:nth-child(even) td{background:#f7faf8;}
    .c{text-align:center;} .amt{color:#1FA363;font-weight:800;white-space:nowrap;}
    .sub{color:#6b7280;font-size:9.5px;margin-top:2px;}
    .pay{font-size:10px;max-width:230px;}
    .tag{padding:1px 7px;border-radius:999px;font-size:9px;font-weight:800;}
    .tag.di{background:#e0edff;color:#1e52c8;} .tag.st{background:#fdecd6;color:#b46212;}
    .pend{background:#fff3cd;color:#8a6d00;padding:1px 7px;border-radius:999px;font-size:9px;font-weight:800;}
    .foot{margin-top:12px;font-size:12px;} .foot b{color:#1FA363;}
  </style></head><body>
    <div class="hdr"><h1>TEHELKA NEWS — Pending Withdrawals</h1>
      <p>${chips} &nbsp;•&nbsp; Total: <b>${rows.length}</b> requests &nbsp;•&nbsp; ${new Date().toLocaleDateString('en-IN')}</p></div>
    <div class="wrap">
      <table>
        <thead><tr><th>#</th><th>Reporter / Mobile</th><th>State</th><th>Joined On</th><th>Amount</th><th>Payment Details</th><th>Type</th><th>Status</th><th>Requested / UTR</th></tr></thead>
        <tbody>${trs}</tbody>
      </table>
      <div class="foot">Total pending amount: <b>₹${total.toLocaleString('en-IN')}</b> &nbsp; (${rows.length} × requests)</div>
    </div></body></html>`;

  const htmlPath = path.join(os.tmpdir(), `pw_${Date.now()}.html`);
  const OUT = path.join(os.homedir(), 'Desktop', exclude ? `Pending_Withdrawals_Others.pdf` : `Pending_Withdrawals_TN_AP_TS.pdf`);
  fs.writeFileSync(htmlPath, html, 'utf8');
  await mongoose.disconnect();
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${OUT}`, `file://${htmlPath}`], { stdio: 'ignore' });
  try { fs.unlinkSync(htmlPath); } catch (_) {}
  console.log('PDF: ' + OUT);
}
main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
