'use strict';

/**
 * District In-charges of a state → PDF (name, mobile, email, district, joined).
 * For collecting ID cards / experience proof & cross-checking hires. READ-ONLY.
 * Usage: node scripts/reports/district-incharges-pdf.js "Tamil Nadu"
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

async function main() {
  const STATE = (process.argv[2] || 'Tamil Nadu').trim();
  await mongoose.connect(process.env.MONGODB_URI);
  const A = mongoose.connection.db.collection('admins');
  const dis = await A.find({ reporterTier: 'district_incharge', assignedState: STATE })
    .project({ name: 1, username: 1, mobileNumber: 1, email: 1, assignedDistricts: 1, assignedState: 1, createdAt: 1, isActive: 1 })
    .toArray();
  dis.sort((a, b) => String((a.assignedDistricts || [])[0] || '').localeCompare(String((b.assignedDistricts || [])[0] || '')) || String(a.name || '').localeCompare(String(b.name || '')));
  console.log(`${STATE} District In-charges: ${dis.length}`);
  if (!dis.length) { console.log('None.'); return process.exit(0); }

  const rows = dis.map((d, i) => {
    const districts = (d.assignedDistricts || []).filter(Boolean).join(', ') || '-';
    return `<tr>
      <td class="c">${i + 1}</td>
      <td><b>${esc(d.name || d.username || '-')}</b></td>
      <td class="mob">${esc(d.mobileNumber || '-')}</td>
      <td>${esc(districts)}</td>
      <td class="em">${esc(d.email || '-')}</td>
      <td>${fmt(d.createdAt)}</td>
      <td class="c sign"></td>
    </tr>`;
  }).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @font-face { font-family:'NotoTe'; src:url('file://${FONT}'); }
    *{box-sizing:border-box;}
    body{font-family:'NotoTe','Noto Sans Telugu',sans-serif;margin:0;color:#111827;font-size:11.5px;}
    .hdr{background:#5E35B1;color:#fff;padding:16px 20px;}
    .hdr h1{margin:0;font-size:18px;} .hdr p{margin:4px 0 0;font-size:11px;opacity:.9;}
    .wrap{padding:14px 18px;}
    .note{background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:8px 10px;margin-bottom:12px;font-size:11px;}
    table{width:100%;border-collapse:collapse;}
    th{background:#0f172a;color:#fff;text-align:left;padding:8px;font-size:10.5px;}
    td{padding:8px;border-bottom:1px solid #eef0f4;vertical-align:top;}
    tr:nth-child(even) td{background:#faf9fe;}
    .c{text-align:center;} .mob{white-space:nowrap;font-weight:700;} .em{font-size:10px;color:#4b5563;}
    .sign{min-width:70px;border-left:1px dashed #cbd5e1;}
    .foot{margin-top:12px;font-size:12px;color:#374151;}
  </style></head><body>
    <div class="hdr"><h1>TEHELKA NEWS — District In-charges (${esc(STATE)})</h1>
      <p>Total: <b>${dis.length}</b> &nbsp;•&nbsp; For ID card & experience-proof verification &nbsp;•&nbsp; ${new Date().toLocaleDateString('en-IN')}</p></div>
    <div class="wrap">
      <div class="note"><b>Purpose:</b> Collect each District In-charge's <b>ID card + experience proof</b> and cross-check the hire. Tick / sign in the last column after verification.</div>
      <table>
        <thead><tr><th>#</th><th>Name</th><th>Mobile</th><th>District</th><th>Email</th><th>Joined</th><th>Verified ✓</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="foot">Total District In-charges in ${esc(STATE)}: <b>${dis.length}</b></div>
    </div></body></html>`;

  const htmlPath = path.join(os.tmpdir(), `di_${Date.now()}.html`);
  const OUT = path.join(os.homedir(), 'Desktop', `District_Incharges_${STATE.replace(/\s+/g, '_')}.pdf`);
  fs.writeFileSync(htmlPath, html, 'utf8');
  await mongoose.disconnect();
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${OUT}`, `file://${htmlPath}`], { stdio: 'ignore' });
  try { fs.unlinkSync(htmlPath); } catch (_) {}
  console.log('PDF: ' + OUT);
}
main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
