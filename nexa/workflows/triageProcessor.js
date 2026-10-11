'use strict';

/**
 * TEHELKA NEXA — Bounded Triage Processor.
 *
 * Fixes "only the first N pending news ever get a NEXA analysis": the manual
 * triage always re-reads the OLDEST pending window, so items beyond one batch
 * were never reached. This processor instead selects ONLY not-yet-analysed
 * pending items and runs the existing shadow triage workflow over them in small,
 * bounded batches — draining the whole backlog over time without an API burst.
 *
 * SAFETY: shadow-only (delegates to pendingNewsTriage.run → writes NexaTask
 * audit records only, never News/status/approval). Inert unless NEXA is active.
 * The auto-loop is additionally gated by NEXA_TRIAGE_AUTO (default OFF).
 */

const { config } = require('../config');
const registry = require('../tools/registry');
const { run: runTriage, WORKFLOW, VERSION } = require('./pendingNewsTriage');

function intEnv(key, fb) {
  const n = parseInt(process.env[key], 10);
  return Number.isFinite(n) && n > 0 ? n : fb;
}

/**
 * Select up to `batchSize` pending items that have NO completed triage NexaTask
 * for the current VERSION. Bounded: scans at most `scanCap` oldest pending.
 * @returns {Promise<{items:Array, scanned:number, remainingKnown:number}>}
 */
async function selectUnanalyzedItems(opts = {}, deps = {}) {
  const NexaTask = deps.NexaTask || require('../../models/NexaTask');
  const batchSize = Math.min(Math.max(parseInt(opts.batchSize, 10) || 15, 1), 50);
  const scanCap = Math.min(Math.max(parseInt(opts.scanCap, 10) || 500, batchSize), 2000);
  const ctx = { role: 'superadmin', workflow: WORKFLOW };

  // Oldest-first pending window (existing read-only tool; capped).
  const pendingRes = deps.getPending
    ? await deps.getPending({ limit: scanCap })
    : await registry.run('getPendingTasks', { limit: scanCap }, ctx);
  const pending = (pendingRes && pendingRes.ok ? pendingRes.result : pendingRes) || [];
  if (!pending.length) return { items: [], scanned: 0, remainingKnown: 0 };

  const ids = pending.map((p) => String(p._id));
  // Which of these already have a completed triage record for this version?
  const doneRows = await NexaTask.find({
    workflow: WORKFLOW,
    'aiDecision.version': VERSION,
    entityId: { $in: ids },
  })
    .select('entityId')
    .lean();
  const done = new Set(doneRows.map((r) => String(r.entityId)));

  const unanalyzed = pending.filter((p) => !done.has(String(p._id)));
  return {
    items: unanalyzed.slice(0, batchSize),
    scanned: pending.length,
    remainingKnown: unanalyzed.length,
  };
}

/** Process ONE bounded batch of not-yet-analysed pending items. Never throws. */
async function processOnce(opts = {}, deps = {}) {
  if (!config.isActive()) {
    return { skipped: true, reason: 'nexa_inactive', selected: 0, created: 0, remainingKnown: 0 };
  }
  try {
    const sel = await selectUnanalyzedItems(opts, deps);
    if (!sel.items.length) {
      return { skipped: false, selected: 0, created: 0, alreadyDone: 0, remainingKnown: 0, scanned: sel.scanned };
    }
    const summary = await (deps.runTriage || runTriage)(
      { items: sel.items, limit: sel.items.length },
      { actorId: deps.actorId || null, actorName: deps.actorName || 'nexa-auto' }
    );
    return {
      skipped: false,
      selected: sel.items.length,
      created: summary.created || 0,
      alreadyDone: summary.alreadyDone || 0,
      remainingKnown: Math.max(0, sel.remainingKnown - (summary.created || 0)),
      scanned: sel.scanned,
    };
  } catch (err) {
    console.warn('[NEXA][triage-processor] processOnce failed (non-fatal):', err && err.message);
    return { skipped: true, reason: 'exception', error: err && err.message, selected: 0, created: 0 };
  }
}

let _timer = null;

/** Start the bounded background drain loop. Gated by NEXA_TRIAGE_AUTO (default OFF). */
function startAutoProcessor(deps = {}) {
  if (_timer) return { started: false, reason: 'already_running' };
  const enabled =
    /^(true|1|yes)$/i.test(String(process.env.NEXA_TRIAGE_AUTO || '')) && config.isActive();
  if (!enabled) return { started: false, reason: 'disabled' };

  const intervalMs = intEnv('NEXA_TRIAGE_AUTO_INTERVAL_MS', 60000); // default 60s/tick
  const batchSize = intEnv('NEXA_TRIAGE_AUTO_BATCH', 15); // default 15 items/tick
  const scanCap = intEnv('NEXA_TRIAGE_AUTO_SCANCAP', 500);

  let running = false;
  const tick = async () => {
    if (running) return; // never overlap ticks
    running = true;
    try {
      const r = await processOnce({ batchSize, scanCap }, deps);
      if (!r.skipped && (r.created || r.selected)) {
        console.log(
          `[NEXA][triage-processor] tick created=${r.created} selected=${r.selected} remaining≈${r.remainingKnown}`
        );
      }
    } finally {
      running = false;
    }
  };
  _timer = setInterval(tick, intervalMs);
  if (_timer.unref) _timer.unref(); // never keep the process alive on its own
  console.log(`[NEXA][triage-processor] auto drain ON — every ${intervalMs}ms, batch ${batchSize}`);
  return { started: true, intervalMs, batchSize, scanCap };
}

function stopAutoProcessor() {
  if (_timer) { clearInterval(_timer); _timer = null; return { stopped: true }; }
  return { stopped: false };
}

module.exports = {
  selectUnanalyzedItems,
  processOnce,
  startAutoProcessor,
  stopAutoProcessor,
};
