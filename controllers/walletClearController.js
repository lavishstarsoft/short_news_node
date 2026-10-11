'use strict';

/**
 * DISTRICT IN-CHARGE — MONTH-WISE WALLET CLEAR (admin dashboard)
 *
 * Flow: admin enters a DI's mobile/name → sees that DI's wallet balance broken
 * down MONTH BY MONTH (how much money entered the wallet each month) → ticks one
 * or more months → "Clear selected months" removes ONLY those months' amount from
 * the wallet, leaving the other months untouched. (e.g. clear August, keep
 * September.)
 *
 * SAFETY:
 *  - Uses the hash-chained wallet helper (processWalletTransaction) so the ledger
 *    stays valid — never writes walletBalance directly.
 *  - A "clear" is a DEBIT tagged monthclear_<id>_<YYYY-MM>_<epoch>; an "undo" is a
 *    CREDIT tagged monthclearrb_<id>_<YYYY-MM>_<epoch>. remaining[month] = money
 *    that entered in that month − net already-cleared, so a month can never be
 *    over-cleared and can be restored.
 *  - Every debit is capped at the live wallet balance (never goes negative).
 *  - Touches ONLY the one selected District In-Charge. No earning/tier/approval
 *    business logic is changed.
 */

const mongoose = require('mongoose');
const { processWalletTransaction } = require('../utils/walletHelpers');

// IST (UTC+5:30) calendar month of a Date → { key:'2026-08', label:'August 2026' }.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function istMonth(date) {
  const ist = new Date(date.getTime() + (5 * 60 + 30) * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth(); // 0..11
  const key = `${y}-${String(m + 1).padStart(2, '0')}`;
  return { key, label: `${MONTHS[m]} ${y}` };
}
function labelOf(key) {
  const [y, m] = key.split('-');
  return `${MONTHS[Number(m) - 1]} ${y}`;
}

// Match transactions whether adminId was stored as ObjectId or as a string.
function idOrClause(d) {
  const aid = String(d._id);
  return { $or: [{ adminId: d._id }, { adminId: aid }] };
}

/**
 * Build the month-wise breakdown for one District In-Charge from the ledger.
 * earned[M]   = credits that entered the wallet in month M (real news rewards /
 *               top-ups; excludes our own undo-credits).
 * cleared[M]  = month-clear debits for M − month-clear undo-credits for M.
 * remaining[M]= max(0, earned − cleared)  → still clearable for that month.
 */
async function computeMonths(db, d) {
  const Tx = db.collection('adminwallettransactions');
  const aid = String(d._id);
  const txs = await Tx.find(idOrClause(d)).project({ amount: 1, type: 1, referenceId: 1, createdAt: 1 }).toArray();

  const earned = {};   // key → sum of genuine credits that month
  const cleared = {};  // key → net already cleared for that month
  for (const t of txs) {
    const ref = String(t.referenceId || '');
    const amt = Number(t.amount) || 0;
    if (ref.startsWith('monthclear_')) {            // our clear debit → attribute to the month it cleared
      const k = ref.split('_')[2];                  // monthclear_<aid>_<YYYY-MM>_<epoch>
      if (k) cleared[k] = (cleared[k] || 0) + (t.type === 'debit' ? amt : 0);
      continue;
    }
    if (ref.startsWith('monthclearrb_')) {          // our undo credit → reduces cleared for that month
      const k = ref.split('_')[2];
      if (k) cleared[k] = (cleared[k] || 0) - (t.type === 'credit' ? amt : 0);
      continue;
    }
    if (t.type === 'credit') {                       // genuine money in → the "earned this month" figure
      const { key } = istMonth(new Date(t.createdAt));
      earned[key] = (earned[key] || 0) + amt;
    }
    // Other debits (real withdrawals) reduce the live balance but are not shown as
    // a clearable month bucket; the per-debit balance cap handles them safely.
  }

  const keys = Array.from(new Set([...Object.keys(earned), ...Object.keys(cleared)])).sort().reverse();
  const months = keys.map((key) => {
    const e = Math.round(earned[key] || 0);
    const c = Math.max(0, Math.round(cleared[key] || 0));
    const remaining = Math.max(0, e - c);
    return { key, label: labelOf(key), earned: e, cleared: c, remaining, done: e > 0 && remaining === 0 };
  }).filter((m) => m.earned > 0 || m.cleared > 0);

  return months;
}

async function resolveDI(db, q) {
  const Admins = db.collection('admins');
  const s = String(q || '').trim();
  const rx = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const or = [{ name: rx }, { username: rx }, { mobileNumber: rx }];
  if (/^[a-f0-9]{24}$/i.test(s)) or.push({ _id: new mongoose.Types.ObjectId(s) });
  // Broadened beyond District In-charges to also cover stringers and reporters.
  // Restricted to earning reporter accounts (tier DI/stringer, or a "Reporter"
  // displayRole) so management wallets (admin/superadmin/editor) can't be cleared
  // by an accidental name/mobile match.
  const reporterOr = [
    { reporterTier: { $in: ['district_incharge', 'stringer'] } },
    { displayRole: /reporter/i },
  ];
  return Admins.find({ $and: [{ $or: or }, { $or: reporterOr }] })
    .project({ name: 1, username: 1, mobileNumber: 1, email: 1, assignedDistricts: 1, assignedStates: 1, assignedState: 1, walletBalance: 1, reporterTier: 1, displayRole: 1 })
    .limit(25).toArray();
}

function typeLabel(d) {
  if (d.reporterTier === 'district_incharge') return 'District In-charge';
  if (d.reporterTier === 'stringer') return 'Stringer';
  return d.displayRole || 'Reporter';
}

function diCard(d) {
  return {
    id: String(d._id),
    name: d.name || d.username || '(no name)',
    mobile: d.mobileNumber || '',
    email: d.email || '',
    district: (d.assignedDistricts || [])[0] || '',
    state: (d.assignedStates && d.assignedStates[0]) || d.assignedState || '',
    walletBalance: Math.round(d.walletBalance || 0),
    type: typeLabel(d),
  };
}

// Pending withdrawal requests for a DI (the wallet is debited only on APPROVAL, so
// a pending request still holds real money — it must be cancelled when we settle
// offline, otherwise approving it later would pay the DI twice).
async function pendingWithdrawals(db, d) {
  const Wd = db.collection('withdrawalrequests');
  const items = await Wd.find({ adminId: d._id, status: 'pending' })
    .project({ amount: 1, createdAt: 1 }).sort({ createdAt: -1 }).toArray();
  const total = items.reduce((s, w) => s + (Number(w.amount) || 0), 0);
  return {
    count: items.length,
    total: Math.round(total),
    items: items.map((w) => ({ id: String(w._id), amount: Math.round(w.amount || 0), date: w.createdAt })),
  };
}

// ── Page ───────────────────────────────────────────────────────────────────
exports.renderPage = async (req, res) => {
  try {
    res.render('wallet-clear', { title: 'Wallet Clear', activePage: 'wallet-clear', admin: req.admin });
  } catch (e) {
    console.error('wallet-clear render error:', e);
    res.status(500).send('Error loading page');
  }
};

// ── Lookup: mobile/name → DI + month-wise breakdown ──────────────────────────
exports.lookup = async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const q = req.query.q;
    if (!q || !String(q).trim()) return res.status(400).json({ error: 'Enter a mobile number or name.' });
    const matches = await resolveDI(db, q);
    if (matches.length === 0) return res.json({ found: false });
    if (matches.length > 1) return res.json({ found: true, multiple: true, list: matches.map(diCard) });
    const d = matches[0];
    const months = await computeMonths(db, d);
    const pending = await pendingWithdrawals(db, d);
    return res.json({ found: true, di: diCard(d), months, pending });
  } catch (e) {
    console.error('wallet-clear lookup error:', e);
    res.status(500).json({ error: 'Lookup failed.' });
  }
};

// ── Apply: clear the selected months from the wallet ─────────────────────────
exports.apply = async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const Admins = db.collection('admins');
    const { adminId, months, cancelPending } = req.body || {};
    if (!adminId || !Array.isArray(months) || months.length === 0) {
      return res.status(400).json({ error: 'Select at least one month.' });
    }
    if (!/^[a-f0-9]{24}$/i.test(String(adminId))) return res.status(400).json({ error: 'Bad id.' });
    const d = await Admins.findOne({ _id: new mongoose.Types.ObjectId(adminId), $or: [{ reporterTier: { $in: ['district_incharge', 'stringer'] } }, { displayRole: /reporter/i }] });
    if (!d) return res.status(404).json({ error: 'Reporter not found.' });

    const breakdown = await computeMonths(db, d);
    const byKey = Object.fromEntries(breakdown.map((m) => [m.key, m]));
    const aid = String(d._id);
    const epoch = Date.now();
    const results = [];
    let totalCleared = 0;

    for (const key of months) {
      const m = byKey[key];
      if (!m || m.remaining <= 0) { results.push({ key, label: labelOf(key), cleared: 0, skipped: 'nothing to clear' }); continue; }
      // Cap at the live balance so the wallet can never go negative.
      const fresh = await Admins.findOne({ _id: d._id }, { projection: { walletBalance: 1 } });
      const bal = Math.round((fresh && fresh.walletBalance) || 0);
      const amount = Math.min(m.remaining, bal);
      if (amount <= 0) { results.push({ key, label: m.label, cleared: 0, skipped: 'wallet already empty' }); continue; }
      await processWalletTransaction({
        adminId: aid, amount, type: 'debit',
        description: `Cleared ${m.label} earnings Rs.${amount} (settled offline; other months kept)`,
        referenceId: `monthclear_${aid}_${key}_${epoch}`,
      });
      totalCleared += amount;
      results.push({ key, label: m.label, cleared: amount });
    }

    // Cancel pending withdrawal request(s) so the offline-settled money can't be
    // paid out a second time. Wallet is debited only on approval, so a pending
    // request still points at real money — mark it 'rejected' with a clear reason.
    let cancelledPending = { count: 0, total: 0 };
    if (cancelPending) {
      const Wd = db.collection('withdrawalrequests');
      const pend = await Wd.find({ adminId: d._id, status: 'pending' }).project({ amount: 1 }).toArray();
      if (pend.length) {
        const total = pend.reduce((s, w) => s + (Number(w.amount) || 0), 0);
        await Wd.updateMany(
          { adminId: d._id, status: 'pending' },
          { $set: { status: 'rejected', remarks: 'Cancelled in wallet month-clear (settled offline)', processedAt: new Date(), monthClearRef: epoch } }
        );
        cancelledPending = { count: pend.length, total: Math.round(total) };
      }
    }

    try {
      await db.collection('auditlogs').insertOne({
        actorName: (req.admin && (req.admin.name || req.admin.username)) || 'admin',
        actorRole: 'admin', action: 'di_wallet_month_clear', entityType: 'Admin', entityId: aid,
        targetId: d._id, targetName: d.name || d.username,
        description: `Cleared months [${results.filter((r) => r.cleared > 0).map((r) => r.label).join(', ') || 'none'}] = Rs.${totalCleared}`
          + (cancelledPending.count ? `; cancelled ${cancelledPending.count} pending withdrawal(s) = Rs.${cancelledPending.total}` : ''),
        createdAt: new Date(),
      });
    } catch (e) { /* audit is best-effort */ }

    const after = await Admins.findOne({ _id: d._id }, { projection: { walletBalance: 1 } });
    const newBalance = Math.round((after && after.walletBalance) || 0);
    const monthsNow = await computeMonths(db, d);
    const pendingNow = await pendingWithdrawals(db, d);
    return res.json({ ok: true, totalCleared, newBalance, results, cancelledPending, months: monthsNow, pending: pendingNow });
  } catch (e) {
    console.error('wallet-clear apply error:', e);
    res.status(500).json({ error: e.message || 'Clear failed.' });
  }
};

// ── Undo: restore a previously cleared month ─────────────────────────────────
exports.rollback = async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const Admins = db.collection('admins');
    const { adminId, month } = req.body || {};
    if (!adminId || !month) return res.status(400).json({ error: 'Missing month.' });
    if (!/^[a-f0-9]{24}$/i.test(String(adminId))) return res.status(400).json({ error: 'Bad id.' });
    const d = await Admins.findOne({ _id: new mongoose.Types.ObjectId(adminId), $or: [{ reporterTier: { $in: ['district_incharge', 'stringer'] } }, { displayRole: /reporter/i }] });
    if (!d) return res.status(404).json({ error: 'Reporter not found.' });

    const breakdown = await computeMonths(db, d);
    const m = breakdown.find((x) => x.key === month);
    if (!m || m.cleared <= 0) return res.status(400).json({ error: 'Nothing was cleared for this month.' });

    const aid = String(d._id);
    await processWalletTransaction({
      adminId: aid, amount: m.cleared, type: 'credit',
      description: `Undo clear of ${m.label} — restored Rs.${m.cleared} to wallet`,
      referenceId: `monthclearrb_${aid}_${month}_${Date.now()}`,
    });
    try {
      await db.collection('auditlogs').insertOne({
        actorName: (req.admin && (req.admin.name || req.admin.username)) || 'admin',
        actorRole: 'admin', action: 'di_wallet_month_clear_undo', entityType: 'Admin', entityId: aid,
        targetId: d._id, targetName: d.name || d.username,
        description: `Undo clear of ${m.label} = Rs.${m.cleared}`, createdAt: new Date(),
      });
    } catch (e) { /* best-effort */ }

    const after = await Admins.findOne({ _id: d._id }, { projection: { walletBalance: 1 } });
    const newBalance = Math.round((after && after.walletBalance) || 0);
    const monthsNow = await computeMonths(db, d);
    const pendingNow = await pendingWithdrawals(db, d);
    return res.json({ ok: true, restored: m.cleared, newBalance, months: monthsNow, pending: pendingNow });
  } catch (e) {
    console.error('wallet-clear rollback error:', e);
    res.status(500).json({ error: e.message || 'Undo failed.' });
  }
};

// Reusable helpers for other controllers (e.g. withdrawals-queue user detail).
exports.computeMonths = computeMonths;
exports.istMonth = istMonth;
