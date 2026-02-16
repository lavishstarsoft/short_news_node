const Ad = require('../models/Ad');
const { deleteFromR2 } = require('../config/cloudflare');

// Render ads list page
async function renderAdsListPage(req, res) {
  try {
    if (req.app.locals.isConnectedToMongoDB) {
      let adsList;
      let selectedStatus = req.query.status || '';

      // Build query based on filters
      const query = {};

      // Status filter
      if (selectedStatus === 'active') {
        query.isActive = true;
      } else if (selectedStatus === 'inactive') {
        query.isActive = false;
      }

      adsList = await Ad.find(query).sort({ createdAt: -1 });

      res.render('ads-list', {
        adsList,
        selectedStatus,
        admin: req.admin
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

      res.render('ads-list', {
        adsList: filteredAdsData,
        selectedStatus,
        admin: req.admin
      });
    }
  } catch (error) {
    console.error('Error fetching ads list:', error);
    res.status(500).json({ error: 'Error fetching ads list' });
  }
}

// Render add ad page
function renderAddAdPage(req, res) {
  res.render('add-ad', { admin: req.admin });
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

    res.render('add-ad', { ad, admin: req.admin });
  } catch (error) {
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
      ad = await Ad.findByIdAndUpdate(id, { isActive: isActive, updatedAt: new Date() }, { new: true });
    } else {
      // Using in-memory storage
      const adsData = req.app.locals.adsData || [];
      const adIndex = adsData.findIndex(a => a._id === id);

      if (adIndex === -1) {
        return res.status(404).json({ error: 'Ad not found' });
      }

      adsData[adIndex].isActive = isActive;
      adsData[adIndex].updatedAt = new Date();
      ad = adsData[adIndex];
    }

    if (!ad) {
      return res.status(404).json({ error: 'Ad not found' });
    }

    res.json({ message: 'Ad status updated successfully', ad });
  } catch (error) {
    res.status(500).json({ error: 'Error updating ad status: ' + error.message });
  }
}

// Get all active ads (for public API)
async function getActiveAds(req, res) {
  try {
    let adsList;

    if (req.app.locals.isConnectedToMongoDB) {
      adsList = await Ad.find({ isActive: true }).sort({ createdAt: -1 });
    } else {
      // Use in-memory storage
      const adsData = req.app.locals.adsData || [];
      adsList = adsData.filter(ad => ad.isActive !== false)
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
  recordAdInteraction
};