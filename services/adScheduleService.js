const Ad = require('../models/Ad');

const SYNC_INTERVAL_MS = 60 * 1000;
let syncTimer = null;

function parseScheduleDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeSchedulePayload(body = {}) {
  const scheduleEnabled = body.scheduleEnabled === true
    || body.scheduleEnabled === 'true'
    || body.scheduleEnabled === 'on';

  const scheduleStart = scheduleEnabled ? parseScheduleDate(body.scheduleStart) : null;
  const scheduleEnd = scheduleEnabled ? parseScheduleDate(body.scheduleEnd) : null;

  if (scheduleEnabled) {
    if (!scheduleStart || !scheduleEnd) {
      throw new Error('Schedule start and end date/time are required');
    }
    if (scheduleEnd <= scheduleStart) {
      throw new Error('Schedule end must be after schedule start');
    }
  }

  return {
    scheduleEnabled,
    scheduleStart,
    scheduleEnd
  };
}

function resolveScheduledIsActive(ad, now = new Date()) {
  if (!ad?.scheduleEnabled) {
    return ad?.isActive !== false;
  }

  const start = ad.scheduleStart ? new Date(ad.scheduleStart) : null;
  const end = ad.scheduleEnd ? new Date(ad.scheduleEnd) : null;
  const current = now.getTime();

  if (start && current < start.getTime()) return false;
  if (end && current > end.getTime()) return false;
  return true;
}

function getAdDisplayStatus(ad, now = new Date()) {
  if (!ad?.scheduleEnabled) {
    return ad?.isActive === false ? 'paused' : 'live';
  }

  const start = ad.scheduleStart ? new Date(ad.scheduleStart) : null;
  const end = ad.scheduleEnd ? new Date(ad.scheduleEnd) : null;
  const current = now.getTime();

  if (end && current > end.getTime()) return 'expired';
  if (start && current < start.getTime()) return 'scheduled';
  if (resolveScheduledIsActive(ad, now)) return 'live';
  return 'paused';
}

function isAdPubliclyVisible(ad, now = new Date()) {
  if (!ad) return false;

  if (!ad.scheduleEnabled) {
    return ad.isActive !== false;
  }

  return resolveScheduledIsActive(ad, now);
}

function buildPublicAdQuery(now = new Date(), lang = null) {
  const query = {
    $or: [
      {
        scheduleEnabled: { $ne: true },
        isActive: true
      },
      {
        scheduleEnabled: true,
        scheduleStart: { $lte: now },
        scheduleEnd: { $gte: now }
      }
    ]
  };

  if (lang) {
    query.language = lang;
  }

  return query;
}

function filterAdsForPublic(ads, now = new Date(), lang = null) {
  return (ads || []).filter((ad) => {
    if (lang && ad.language !== lang) return false;
    return isAdPubliclyVisible(ad, now);
  });
}

function applyScheduleFields(target, body) {
  const schedule = normalizeSchedulePayload(body);
  target.scheduleEnabled = schedule.scheduleEnabled;

  if (schedule.scheduleEnabled) {
    target.scheduleStart = schedule.scheduleStart;
    target.scheduleEnd = schedule.scheduleEnd;
    target.isActive = resolveScheduledIsActive(target, new Date());
  } else {
    target.scheduleStart = null;
    target.scheduleEnd = null;
    if (typeof body.isActive !== 'undefined') {
      target.isActive = body.isActive === true || body.isActive === 'true';
    }
  }

  return target;
}

async function syncScheduledAds() {
  const now = new Date();
  const scheduledAds = await Ad.find({ scheduleEnabled: true }).lean();
  let changedCount = 0;

  for (const ad of scheduledAds) {
    const nextActive = resolveScheduledIsActive(ad, now);
    if (ad.isActive !== nextActive) {
      await Ad.findByIdAndUpdate(ad._id, {
        isActive: nextActive,
        updatedAt: now
      });
      changedCount += 1;
    }
  }

  return { checked: scheduledAds.length, changed: changedCount };
}

function startAdScheduleSync() {
  if (syncTimer) return;

  const run = async () => {
    try {
      const result = await syncScheduledAds();
      if (result.changed > 0) {
        console.log(`Ad schedule sync: updated ${result.changed}/${result.checked} scheduled ads`);
        try {
          const { clearCache } = require('../middleware/cache');
          await clearCache('cache:/api/public/ads*');
        } catch (cacheError) {
          console.warn('Ad schedule sync cache clear skipped:', cacheError.message);
        }
      }
    } catch (error) {
      console.error('Ad schedule sync failed:', error.message);
    }
  };

  run();
  syncTimer = setInterval(run, SYNC_INTERVAL_MS);
}

function toDatetimeLocalValue(date) {
  if (!date) return '';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';

  const pad = (value) => String(value).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

module.exports = {
  SYNC_INTERVAL_MS,
  parseScheduleDate,
  normalizeSchedulePayload,
  resolveScheduledIsActive,
  getAdDisplayStatus,
  isAdPubliclyVisible,
  buildPublicAdQuery,
  filterAdsForPublic,
  applyScheduleFields,
  syncScheduledAds,
  startAdScheduleSync,
  toDatetimeLocalValue
};
