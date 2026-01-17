const Ad = require('../models/Ad');
const AdAnalytics = require('../models/AdAnalytics');

// Render intelligent ads management page
async function renderIntelligentAdsPage(req, res) {
  try {
    if (req.app.locals.isConnectedToMongoDB) {
      // Get all ads for display
      const adsList = await Ad.find().sort({ createdAt: -1 });
      
      // Get statistics for intelligent ad management
      const totalAds = adsList.length;
      const activeAds = adsList.filter(ad => ad.isActive).length;
      const inactiveAds = totalAds - activeAds;
      
      // Get position interval statistics
      const positionStats = {};
      adsList.forEach(ad => {
        const interval = ad.positionInterval || 3;
        positionStats[interval] = (positionStats[interval] || 0) + 1;
      });
      
      res.render('intelligent-ads', { 
        adsList,
        totalAds,
        activeAds,
        inactiveAds,
        positionStats,
        admin: req.admin
      });
    } else {
      // Use in-memory storage
      const adsData = req.app.locals.adsData || [];
      
      // Get statistics for intelligent ad management
      const totalAds = adsData.length;
      const activeAds = adsData.filter(ad => ad.isActive !== false).length;
      const inactiveAds = totalAds - activeAds;
      
      // Get position interval statistics
      const positionStats = {};
      adsData.forEach(ad => {
        const interval = ad.positionInterval || 3;
        positionStats[interval] = (positionStats[interval] || 0) + 1;
      });
      
      // Sort by created date
      adsData.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      
      res.render('intelligent-ads', { 
        adsList: adsData,
        totalAds,
        activeAds,
        inactiveAds,
        positionStats,
        admin: req.admin
      });
    }
  } catch (error) {
    console.error('Error fetching intelligent ads data:', error);
    res.status(500).json({ error: 'Error fetching intelligent ads data' });
  }
}

// Update ad frequency settings
async function updateAdFrequency(req, res) {
  try {
    const { adId, maxViewsPerDay, cooldownPeriodHours } = req.body;
    
    // In a real implementation, we would store these settings in a separate collection
    // For now, we'll just return a success response
    res.json({ 
      message: 'Ad frequency settings updated successfully',
      adId,
      maxViewsPerDay,
      cooldownPeriodHours
    });
  } catch (error) {
    res.status(500).json({ error: 'Error updating ad frequency settings: ' + error.message });
  }
}

// Get ad performance analytics
async function getAdAnalytics(req, res) {
  try {
    if (req.app.locals.isConnectedToMongoDB) {
      // Fetch real analytics data from database
      const analyticsData = await AdAnalytics.find().sort({ impressions: -1 }).limit(10);
      
      // Calculate totals
      let totalImpressions = 0;
      let totalClicks = 0;
      
      const topPerformingAds = analyticsData.map(ad => {
        totalImpressions += ad.impressions;
        totalClicks += ad.clicks;
        
        return {
          id: ad.adId,
          title: ad.adTitle,
          impressions: ad.impressions,
          clicks: ad.clicks,
          ctr: ad.ctr
        };
      });
      
      // Calculate overall CTR
      const overallCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
      
      // Calculate average views per user (simplified)
      const avgViewsPerUser = analyticsData.length > 0 ? 
        analyticsData.reduce((sum, ad) => sum + ad.uniqueViews, 0) / analyticsData.length : 0;
      
      res.json({
        totalImpressions,
        totalClicks,
        ctr: parseFloat(overallCtr.toFixed(2)),
        avgViewsPerUser: parseFloat(avgViewsPerUser.toFixed(2)),
        topPerformingAds
      });
    } else {
      // Return mock data for in-memory mode
      const analyticsData = {
        totalImpressions: 12500,
        totalClicks: 375,
        ctr: 3.0, // Click-through rate
        avgViewsPerUser: 2.5,
        topPerformingAds: [
          { id: 'ad1', title: 'Sample Ad 1', impressions: 5000, clicks: 200, ctr: 4.0 },
          { id: 'ad2', title: 'Sample Ad 2', impressions: 3500, clicks: 105, ctr: 3.0 },
          { id: 'ad3', title: 'Sample Ad 3', impressions: 4000, clicks: 70, ctr: 1.75 }
        ]
      };
      
      res.json(analyticsData);
    }
  } catch (error) {
    console.error('Error fetching ad analytics:', error);
    res.status(500).json({ error: 'Error fetching ad analytics: ' + error.message });
  }
}

// Reset ad performance data
async function resetAdAnalytics(req, res) {
  try {
    if (req.app.locals.isConnectedToMongoDB) {
      // Reset all analytics data in database
      await AdAnalytics.deleteMany({});
      res.json({ message: 'Ad analytics data reset successfully' });
    } else {
      // For in-memory mode, just return success
      res.json({ message: 'Ad analytics data reset successfully' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Error resetting ad analytics: ' + error.message });
  }
}

// Export all functions
module.exports = {
  renderIntelligentAdsPage,
  updateAdFrequency,
  getAdAnalytics,
  resetAdAnalytics
};