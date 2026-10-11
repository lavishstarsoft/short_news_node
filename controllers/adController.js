const Ad = require('../models/Ad');
const AdInteraction = require('../models/AdInteraction');
const Language = require('../models/Language');
const Category = require('../models/Category');
const { deleteFromR2 } = require('../config/cloudflare');
const {
  applyScheduleFields,
  buildPublicAdQuery,
  filterAdsForPublic,
  getAdDisplayStatus,
  syncScheduledAds,
  toDatetimeLocalValue
} = require('../services/adScheduleService');

// Render ads list page
// ── Per-language ad-frequency ("feed comfort") helper ───────────────────────
// Each active CUSTOM ad shows every `positionInterval` news cards, so the ads of
// one language interleave: ads-per-100-cards ≈ Σ(100/interval). The effective
// gap between any two ads ≈ 1 / Σ(1/interval). AdMob is global (10–14) → excluded.
function computeLangStats(ads, langName) {
  const by = {};
  (ads || []).forEach((a) => {
    if (a.isActive === false) return;
    if (a.useAdMob === true) return;
    const lang = (a.language || 'en');
    const n = Math.max(1, parseInt(a.positionInterval, 10) || 3);
    if (!by[lang]) by[lang] = { count: 0, sumInv: 0, min: 1e9 };
    by[lang].count += 1;
    by[lang].sumInv += 1 / n;
    by[lang].min = Math.min(by[lang].min, n);
  });
  const order = { bad: 0, warn: 1, good: 2 };
  return Object.keys(by).map((lang) => {
    const s = by[lang];
    const gapExact = s.sumInv > 0 ? 1 / s.sumInv : 999;
    const gap = Math.round(gapExact);
    const level = gapExact >= 6 ? 'good' : (gapExact >= 3 ? 'warn' : 'bad');
    let freqText;
    if (gapExact >= 1.5) freqText = '~1 ad every ' + gap + ' news cards';
    else if (gapExact >= 0.9) freqText = '~1 ad on almost every card';
    else freqText = 'more than 1 ad per card — some ads won’t even show';
    let advice;
    if (level === 'good') advice = 'Good — comfortable spacing.';
    else if (level === 'warn') advice = 'A bit frequent. Aim for ~1 ad every 6 cards: raise intervals slightly (tightest now ' + s.min + ').';
    else advice = 'Too many ads for this language. Keep only 1–2 ads, OR set every ad’s interval to ' + Math.ceil(6 * s.count) + '+ (tightest now ' + s.min + ').';
    return { lang, name: (langName && langName[lang]) || lang, count: s.count, min: s.min, gap, freqText, level, advice };
  }).sort((a, b) => (order[a.level] - order[b.level]) || a.name.localeCompare(b.name));
}

// Live stats for one language (used by the add/edit interval hint). `exclude`
// skips the ad being edited so its own old interval isn't double-counted.
async function langStats(req, res) {
  try {
    const lang = String((req.query && req.query.lang) || '').toLowerCase();
    const exclude = String((req.query && req.query.exclude) || '');
    let ads = await Ad.find({ isActive: { $ne: false }, useAdMob: { $ne: true }, language: lang }).lean();
    if (exclude) ads = ads.filter((a) => String(a._id) !== exclude);
    let sumInv = 0;
    ads.forEach((a) => { sumInv += 1 / Math.max(1, parseInt(a.positionInterval, 10) || 3); });
    res.json({ ok: true, count: ads.length, sumInv });
  } catch (e) {
    res.status(500).json({ ok: false, count: 0, sumInv: 0 });
  }
}

// Auto-fix: space out ALL active custom ads of a language so the feed is
// comfortable (~1 ad every 6 cards) while keeping every ad. With N ads, setting
// each interval = ceil(6·N) makes Σ(1/interval) = 1/6 → gap 6.
async function autoBalance(req, res) {
  try {
    const lang = String((req.body && req.body.lang) || '').toLowerCase();
    if (!lang) return res.status(400).json({ ok: false, error: 'lang required' });
    const ads = await Ad.find({ isActive: { $ne: false }, useAdMob: { $ne: true }, language: lang }).select('_id');
    if (!ads.length) return res.json({ ok: true, updated: 0, interval: 0 });
    const interval = Math.min(100, Math.max(6, Math.ceil(6 * ads.length)));
    await Ad.updateMany(
      { _id: { $in: ads.map((a) => a._id) } },
      { $set: { positionInterval: interval, updatedAt: new Date() } }
    );
    try { req.app.locals.io?.emit('ads_changed', { at: Date.now() }); } catch (_) {}
    res.json({ ok: true, updated: ads.length, interval });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

async function renderAdsListPage(req, res) {
  try {
    const selectedStatus = req.query.status || '';
    console.log(`DEBUG: renderAdsListPage - isConnectedToMongoDB: ${req.app.locals.isConnectedToMongoDB}, Status Filter: ${selectedStatus}`);

    if (req.app.locals.isConnectedToMongoDB) {
      // Build query based on filters
      const query = {};
      if (selectedStatus === 'active') {
        query.isActive = true;
      } else if (selectedStatus === 'inactive') {
        query.isActive = false;
      }

      const adsList = await Ad.find(query).sort({ createdAt: -1 }).lean();
      const enrichedAds = adsList.map((ad) => ({
        ...ad,
        displayStatus: getAdDisplayStatus(ad)
      }));
      console.log(`DEBUG: Found ${adsList.length} ads in MongoDB.`);
      if (adsList.length > 0) {
        console.log('DEBUG: Ad Titles:', adsList.map(a => a.title).join(', '));
      }

      let langName = {};
      try { (await Language.getActiveLanguages()).forEach((l) => { langName[l.code] = l.name; }); } catch (_) {}
      const activeForStats = await Ad.find({ isActive: { $ne: false } }).lean();

      res.render('ads-list', {
        adsList: enrichedAds,
        selectedStatus,
        admin: req.admin,
        langStats: computeLangStats(activeForStats, langName)
      });
    } else {
      // Use in-memory storage
      const adsData = req.app.locals.adsData || [];

      // Filter ads by status if specified
      let filteredAdsData = adsData;

      // Status filter
      if (selectedStatus === 'active') {
        filteredAdsData = filteredAdsData.filter(ad => ad.isActive !== false);
      } else if (selectedStatus === 'inactive') {
        filteredAdsData = filteredAdsData.filter(ad => ad.isActive === false);
      }

      // Sort by created date
      filteredAdsData.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const enrichedAds = filteredAdsData.map((ad) => ({
        ...ad,
        displayStatus: getAdDisplayStatus(ad)
      }));

      res.render('ads-list', {
        adsList: enrichedAds,
        selectedStatus,
        admin: req.admin,
        langStats: computeLangStats(adsData, {})
      });
    }
  } catch (error) {
    console.error('Error fetching ads list:', error);
    res.status(500).json({ error: 'Error fetching ads list' });
  }
}

// Render add ad page
async function renderAddAdPage(req, res) {
  try {
    const languages = await Language.getActiveLanguages();
    const categories = await Category.find({ type: { $in: ['news', null] } }).select('name').sort({ name: 1 }).lean();
    res.render('add-ad', { admin: req.admin, languages, categories, toDatetimeLocalValue });
  } catch (error) {
    console.error('Error fetching languages for add ad page:', error);
    res.render('add-ad', { admin: req.admin, languages: [], categories: [], toDatetimeLocalValue });
  }
}

// Render edit ad page
async function renderEditAdPage(req, res) {
  try {
    let ad;

    if (req.app.locals.isConnectedToMongoDB) {
      ad = await Ad.findById(req.params.id);
    } else {
      // Use in-memory storage
      const adsData = req.app.locals.adsData || [];
      ad = adsData.find(a => a._id === req.params.id);
    }

    if (!ad) {
      return res.status(404).json({ error: 'Ad not found' });
    }

    const languages = await Language.getActiveLanguages();
    const categories = await Category.find({ type: { $in: ['news', null] } }).select('name').sort({ name: 1 }).lean();

    res.render('add-ad', { ad, admin: req.admin, languages, categories, toDatetimeLocalValue });
  } catch (error) {
    console.error('Error fetching ad for editing:', error);
    res.status(500).json({ error: 'Error fetching ad for editing' });
  }
}

// Create new ad
async function createAd(req, res) {
  try {
    const adData = {
      ...req.body,
      author: req.admin.username,
      authorId: req.admin.id,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    applyScheduleFields(adData, req.body);

    // Set default values for intelligent ad fields if not provided
    adData.maxViewsPerDay = adData.maxViewsPerDay || 3;
    adData.cooldownPeriodHours = adData.cooldownPeriodHours || 24;
    adData.frequencyControlEnabled = adData.frequencyControlEnabled !== undefined ? adData.frequencyControlEnabled : true;
    adData.userBehaviorTrackingEnabled = adData.userBehaviorTrackingEnabled !== undefined ? adData.userBehaviorTrackingEnabled : true;

    // If we have imageUrls array, ensure imageUrl field is set to first image
    if (adData.imageUrls && adData.imageUrls.length > 0) {
      adData.imageUrl = adData.imageUrls[0];
    }

    let ad;

    if (req.app.locals.isConnectedToMongoDB) {
      ad = new Ad(adData);
      await ad.save();
    } else {
      // Use in-memory storage
      const adsData = req.app.locals.adsData || [];
      adData._id = `ad_${Date.now()}`; // Simple ID generation for in-memory storage
      adsData.push(adData);
      req.app.locals.adsData = adsData;
      ad = adData;
    }

    // Tell connected apps an ad changed → refetch now (no feed-reload wait).
    try { req.app.locals.io?.emit('ads_changed', { at: Date.now() }); } catch (_) {}
    res.status(201).json(ad);
  } catch (error) {
    console.error('Error creating ad:', error);
    res.status(400).json({ error: 'Error creating ad: ' + error.message });
  }
}

// Update ad
async function updateAd(req, res) {
  try {
    const { id } = req.params;
    let ad;

    // Fetch existing ad first
    if (req.app.locals.isConnectedToMongoDB) {
      ad = await Ad.findById(id);
    } else {
      const adsData = req.app.locals.adsData || [];
      ad = adsData.find(a => a._id === id);
    }

    if (!ad) {
      return res.status(404).json({ error: 'Ad not found' });
    }

    // Handle multiple images
    const updateData = {
      ...req.body,
      updatedAt: new Date()
    };

    // Set default values for intelligent ad fields if not provided
    updateData.maxViewsPerDay = updateData.maxViewsPerDay || 3;
    updateData.cooldownPeriodHours = updateData.cooldownPeriodHours || 24;
    updateData.frequencyControlEnabled = updateData.frequencyControlEnabled !== undefined ? updateData.frequencyControlEnabled : true;
    updateData.userBehaviorTrackingEnabled = updateData.userBehaviorTrackingEnabled !== undefined ? updateData.userBehaviorTrackingEnabled : true;

    // If we have imageUrls array, ensure imageUrl field is set to first image
    if (updateData.imageUrls && updateData.imageUrls.length > 0) {
      updateData.imageUrl = updateData.imageUrls[0];
    }

    applyScheduleFields(updateData, req.body);

    // If image is being updated, delete the old image from Cloudflare R2
    if (updateData.imageUrl && ad.imageUrl && updateData.imageUrl !== ad.imageUrl) {
      // Check if the old image is used in the new imageUrls list before deleting
      const isStillUsed = updateData.imageUrls && updateData.imageUrls.includes(ad.imageUrl);
      if (!isStillUsed) {
        await deleteFromR2(ad.imageUrl);
      }
    }

    // Also handle imageUrls array if provided (delete elements not in new list)
    if (updateData.imageUrls && ad.imageUrls) {
      const oldImages = ad.imageUrls.filter(img => !updateData.imageUrls.includes(img) && img !== updateData.imageUrl);
      for (const img of oldImages) {
        await deleteFromR2(img);
      }
    }

    if (req.app.locals.isConnectedToMongoDB) {
      ad = await Ad.findByIdAndUpdate(id, updateData, { new: true });
    } else {
      // Use in-memory storage
      const adsData = req.app.locals.adsData || [];
      const adIndex = adsData.findIndex(a => a._id === id);
      adsData[adIndex] = { ...adsData[adIndex], ...updateData };
      req.app.locals.adsData = adsData;
      ad = adsData[adIndex];
    }

    try { req.app.locals.io?.emit('ads_changed', { at: Date.now() }); } catch (_) {}
    res.json(ad);
  } catch (error) {
    console.error('Error updating ad:', error);
    res.status(400).json({ error: 'Error updating ad: ' + error.message });
  }
}

// Delete ad
async function deleteAd(req, res) {
  try {
    let result;

    if (req.app.locals.isConnectedToMongoDB) {
      result = await Ad.findByIdAndDelete(req.params.id);

      // Delete media from Cloudflare R2
      if (result && result.imageUrl) {
        await deleteFromR2(result.imageUrl);
      }
      if (result && result.imageUrls) {
        for (const img of result.imageUrls) {
          if (img !== result.imageUrl) { // Avoid double delete
            await deleteFromR2(img);
          }
        }
      }
    } else {
      // Use in-memory storage
      const adsData = req.app.locals.adsData || [];
      const adIndex = adsData.findIndex(a => a._id === req.params.id);

      if (adIndex === -1) {
        return res.status(404).json({ error: 'Ad not found' });
      }

      const deletedAd = adsData.splice(adIndex, 1);
      req.app.locals.adsData = adsData;
      result = deletedAd[0];
    }

    if (!result) {
      return res.status(404).json({ error: 'Ad not found' });
    }

    try { req.app.locals.io?.emit('ads_changed', { at: Date.now() }); } catch (_) {}
    res.json({ message: 'Ad deleted successfully' });
  } catch (error) {
    res.status(400).json({ error: 'Error deleting ad' });
  }
}

// Toggle ad active status
async function toggleAdStatus(req, res) {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    let ad;

    if (req.app.locals.isConnectedToMongoDB) {
      ad = await Ad.findById(id);
      if (!ad) {
        return res.status(404).json({ error: 'Ad not found' });
      }

      ad.isActive = isActive;
      ad.scheduleEnabled = false;
      ad.scheduleStart = null;
      ad.scheduleEnd = null;
      ad.updatedAt = new Date();
      await ad.save();
    } else {
      // Using in-memory storage
      const adsData = req.app.locals.adsData || [];
      const adIndex = adsData.findIndex(a => a._id === id);

      if (adIndex === -1) {
        return res.status(404).json({ error: 'Ad not found' });
      }

      adsData[adIndex].isActive = isActive;
      adsData[adIndex].scheduleEnabled = false;
      adsData[adIndex].scheduleStart = null;
      adsData[adIndex].scheduleEnd = null;
      adsData[adIndex].updatedAt = new Date();
      ad = adsData[adIndex];
    }

    if (!ad) {
      return res.status(404).json({ error: 'Ad not found' });
    }

    try { req.app.locals.io?.emit('ads_changed', { at: Date.now() }); } catch (_) {}
    res.json({ message: 'Ad status updated successfully', ad });
  } catch (error) {
    res.status(500).json({ error: 'Error updating ad status: ' + error.message });
  }
}

// Get all active ads (for public API)
async function getActiveAds(req, res) {
  try {
    const { lang } = req.query;
    const now = new Date();
    let adsList;

    if (req.app.locals.isConnectedToMongoDB) {
      await syncScheduledAds();
      adsList = await Ad.find(buildPublicAdQuery(now, lang)).sort({ createdAt: -1 }).lean();
    } else {
      const adsData = req.app.locals.adsData || [];
      adsList = filterAdsForPublic(adsData, now, lang)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    res.json(adsList);
  } catch (error) {
    res.status(500).json({ error: 'Error fetching ads' });
  }
}

// Record ad interaction (view or click)
async function recordAdInteraction(req, res) {
  try {
    const { adId, adTitle, interactionType, viewDurationSeconds, platform } = req.body;

    if (!adId || !interactionType) {
      return res.status(400).json({ error: 'adId and interactionType are required' });
    }

    const interaction = new AdInteraction({
      adId,
      adTitle,
      interactionType,
      viewDurationSeconds: viewDurationSeconds || 0,
      platform,
      timestamp: new Date()
    });

    await interaction.save();

    // Impression budget: count views, auto-pause the ad when the budget is hit.
    if (interactionType === 'view') {
      try {
        const updated = await Ad.findByIdAndUpdate(adId, { $inc: { impressionCount: 1 } }, { new: true });
        if (updated && updated.maxImpressions > 0 && updated.impressionCount >= updated.maxImpressions && updated.isActive !== false) {
          updated.isActive = false;
          updated.updatedAt = new Date();
          await updated.save();
          try { req.app.locals.io?.emit('ads_changed', { at: Date.now() }); } catch (_) {}
        }
      } catch (_) { /* budget tracking is best-effort */ }
    }

    res.status(201).json({ message: 'Interaction recorded successfully' });
  } catch (error) {
    console.error('Error recording ad interaction:', error);
    res.status(500).json({ error: 'Error recording ad interaction' });
  }
}

// Export all functions
module.exports = {
  renderAdsListPage,
  renderAddAdPage,
  renderEditAdPage,
  createAd,
  updateAd,
  deleteAd,
  toggleAdStatus,
  getActiveAds,
  recordAdInteraction,
  langStats,
  autoBalance
};