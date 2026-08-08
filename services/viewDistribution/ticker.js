'use strict';

/**
 * ticker.js — leader-only scheduler (replaces the Phase-2 stub).
 *
 * Started by index.js ONLY on leadership gain, stopped on leadership loss, so
 * exactly one instance enqueues cluster-wide (PM2-safe, no duplicate enqueue).
 *
 * Each tick it:
 *   - loads active campaigns,
 *   - auto-completes expired ones (past endAt or past their duration),
 *   - computes cycleIndex = floor((now - startAt)/60000) and enqueues one job per
 *     campaign per cycle (queue dedups by campaignId+cycleIndex).
 *
 * It also bootstraps the Worker (handler = applier.processCycle) so processing
 * happens on the leader. The queue is a consumer group, so workers can later be
 * started on every instance to scale consumers out with no change here.
 *
 * Guarantees:
 *   - RESTART-SAFE: cycleIndex is derived from wall-clock, so a new leader resumes
 *     at the correct cycle; dedup + the Applier's ledger prevent reprocessing.
 *   - ERROR-ISOLATED: a failure for one campaign never affects others or the loop.
 *   - SELF-SCHEDULING: setTimeout with a busy-guard prevents overlapping ticks.
 *   - Double-guarded leader check (belt-and-suspenders against election races).
 */

const queue = require('./queue');
const worker = require('./worker');
const applier = require('./applier');
const leader = require('./leader');
const ViewCampaign = require('./models/ViewCampaign');
const { LOG_PREFIX } = require('./constants');

// Tick faster than the 1-min cycle so every minute boundary is caught reliably;
// dedup makes repeated enqueues of the same cycle a no-op.
const TICK_MS = 30000;

let _running = false;
let _busy = false;
let _timer = null;
let _metrics = null;

function freshMetrics() {
  return { ticks: 0, enqueued: 0, completed: 0, errors: 0, lastTickAt: null };
}

function isRunning() {
  return _running;
}
function getMetrics() {
  return { ..._metrics, running: _running, worker: worker.getMetrics() };
}

/**
 * Pure per-campaign decision (testable without DB/Redis).
 * @returns {{action:'enqueue'|'complete'|'skip', cycleIndex?:number, reason?:string}}
 */
function planCycle(campaign, now) {
  const start = campaign.startAt ? new Date(campaign.startAt).getTime() : now;
  // Unlimited (24×7): the ONLY behavioural change — such campaigns never
  // auto-complete by end time or duration; they keep enqueuing cycles until a
  // Super Admin pauses/cancels/deletes them. Finite campaigns are unchanged.
  const isUnlimited = campaign.durationType === 'unlimited';

  if (!isUnlimited && campaign.endAt && now > new Date(campaign.endAt).getTime()) {
    return { action: 'complete', reason: 'past_end' };
  }
  if (now < start) {
    return { action: 'skip', reason: 'not_started' };
  }
  const cycleIndex = Math.floor((now - start) / 60000);
  if (!isUnlimited) {
    const totalCycles = Math.max(1, Number(campaign.durationMinutes) || 0);
    if (cycleIndex > totalCycles) {
      return { action: 'complete', reason: 'past_duration', cycleIndex };
    }
  }
  return { action: 'enqueue', cycleIndex };
}

async function completeCampaign(id, reason) {
  // Atomic: only flips a still-active campaign; concurrent leaders are harmless.
  const res = await ViewCampaign.updateOne(
    { _id: id, status: 'active' },
    { $set: { status: 'completed' } }
  );
  if (res.modifiedCount) {
    _metrics.completed++;
    console.log(`${LOG_PREFIX} ticker: campaign ${id} completed (${reason})`);
  }
}

/** One enqueue pass over active campaigns. Error-isolated per campaign. */
async function tickOnce(now = Date.now()) {
  const campaigns = await ViewCampaign.find({ status: 'active' })
    .select('startAt endAt durationMinutes durationType')
    .lean();

  for (const c of campaigns) {
    try {
      const plan = planCycle(c, now);
      if (plan.action === 'complete') {
        await completeCampaign(c._id, plan.reason);
      } else if (plan.action === 'enqueue') {
        const r = await queue.enqueue(String(c._id), plan.cycleIndex);
        if (r && r.enqueued) _metrics.enqueued++;
      }
      // 'skip' => not started yet, do nothing
    } catch (err) {
      _metrics.errors++;
      console.error(`${LOG_PREFIX} ticker: campaign ${c && c._id} error:`, err.message);
    }
  }
}

async function tick() {
  if (!_running) return;
  // Double-guard: if we lost leadership between schedules, do not enqueue.
  if (!leader.isLeader()) {
    scheduleNext();
    return;
  }
  _busy = true;
  _metrics.ticks++;
  _metrics.lastTickAt = Date.now();
  try {
    await tickOnce(Date.now());
  } catch (err) {
    _metrics.errors++;
    console.error(`${LOG_PREFIX} ticker tick error:`, err.message);
  } finally {
    _busy = false;
    scheduleNext();
  }
}

function scheduleNext() {
  if (!_running) return;
  _timer = setTimeout(tick, TICK_MS);
  if (_timer.unref) _timer.unref();
}

/**
 * Start the ticker + worker. Called by index.js on leadership gain. Idempotent.
 * @param {object} [io] Socket.io instance (reserved for progress events).
 */
function start(io) {
  if (_running) return;
  _running = true;
  _metrics = freshMetrics();

  // Bootstrap the consumer on this (leader) instance.
  worker.start({
    handler: applier.processCycle,
    consumerName: leader.instanceId()
  });

  // Kick the enqueue loop immediately, then self-schedule.
  tick();
  console.log(`${LOG_PREFIX} ticker started (leader)`);
}

/** Stop ticker + worker. Called on leadership loss / shutdown. */
async function stop() {
  if (!_running) return;
  _running = false;
  if (_timer) clearTimeout(_timer);
  _timer = null;
  try {
    await worker.stop();
  } catch (err) {
    console.error(`${LOG_PREFIX} ticker: worker stop error:`, err.message);
  }
  console.log(`${LOG_PREFIX} ticker stopped`);
}

module.exports = {
  start,
  stop,
  isRunning,
  getMetrics,
  // exported for tests
  planCycle,
  tickOnce
};
