const { getCacheStats, resetCacheStats, closeRedisConnection, isRedisAvailable } = require('../config/redis');
const { clearCache, clearAllCache } = require('../middleware/cache');

// Get cache statistics
const getCacheStatistics = async (req, res) => {
    try {
        const stats = await getCacheStats();
        res.json(stats);
    } catch (error) {
        console.error('Error getting cache statistics:', error);
        res.status(500).json({ error: 'Error getting cache statistics' });
    }
};

// Clear cache by pattern
const clearCacheByPattern = async (req, res) => {
    try {
        const { pattern } = req.body;

        if (!pattern) {
            return res.status(400).json({ error: 'Pattern is required' });
        }

        await clearCache(pattern);
        res.json({
            success: true,
            message: `Cache cleared for pattern: ${pattern}`
        });
    } catch (error) {
        console.error('Error clearing cache:', error);
        res.status(500).json({ error: 'Error clearing cache' });
    }
};

// Clear all cache
const clearAllCacheData = async (req, res) => {
    try {
        await clearAllCache();
        res.json({
            success: true,
            message: 'All cache cleared successfully'
        });
    } catch (error) {
        console.error('Error clearing all cache:', error);
        res.status(500).json({ error: 'Error clearing all cache' });
    }
};

// Reset cache statistics
const resetStatistics = async (req, res) => {
    try {
        resetCacheStats();
        res.json({
            success: true,
            message: 'Cache statistics reset successfully'
        });
    } catch (error) {
        console.error('Error resetting statistics:', error);
        res.status(500).json({ error: 'Error resetting statistics' });
    }
};

// Get all cache keys
const getAllCacheKeys = async (req, res) => {
    try {
        if (!isRedisAvailable()) {
            return res.status(503).json({
                error: 'Redis is not available'
            });
        }

        const { redisClient } = require('../config/redis');
        const pattern = req.query.pattern || 'cache:*';
        const keys = await redisClient.keys(pattern);

        // Get TTL for each key
        const keysWithTTL = await Promise.all(
            keys.map(async (key) => {
                const ttl = await redisClient.ttl(key);
                return { key, ttl };
            })
        );

        res.json({
            success: true,
            count: keys.length,
            keys: keysWithTTL
        });
    } catch (error) {
        console.error('Error getting cache keys:', error);
        res.status(500).json({ error: 'Error getting cache keys' });
    }
};

// Warm cache with popular data
const warmPopularCache = async (req, res) => {
    try {
        const News = require('../models/News');
        const { warmCache } = require('../config/redis');
        const { redisClient } = require('../config/redis');

        // Data loader function for cache warming
        const loadPopularData = async () => {
            // Get latest news
            const latestNews = await News.find()
                .sort({ publishedAt: -1 })
                .limit(50);

            // Cache the popular news endpoint
            if (latestNews.length > 0) {
                const transformedNews = latestNews.map(news => ({
                    id: news._id,
                    title: news.title,
                    content: news.content,
                    imageUrl: news.thumbnailUrl || news.mediaUrl || news.imageUrl,
                    mediaUrl: news.mediaUrl || news.imageUrl,
                    mediaType: news.mediaType || 'image',
                    category: news.category,
                    location: news.location,
                    publishedAt: news.publishedAt,
                    likes: news.likes || 0,
                    dislikes: news.dislikes || 0,
                    comments: news.comments || 0,
                }));

                // Cache main news endpoint
                await redisClient.setEx(
                    'cache:/api/public/news',
                    300,
                    JSON.stringify(transformedNews)
                );

                console.log('✅ Cached main news endpoint');
            }

            return latestNews;
        };

        const success = await warmCache(loadPopularData);

        if (success) {
            res.json({
                success: true,
                message: 'Cache warmed successfully with popular data'
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to warm cache'
            });
        }
    } catch (error) {
        console.error('Error warming cache:', error);
        res.status(500).json({ error: 'Error warming cache' });
    }
};

// Render cache management page
const renderCacheManagementPage = async (req, res) => {
    try {
        const stats = await getCacheStats();
        res.render('cache-management', {
            admin: req.admin,
            activePage: 'cache',
            stats
        });
    } catch (error) {
        console.error('Error rendering cache management page:', error);
        res.status(500).json({ error: 'Error rendering cache management page' });
    }
};

module.exports = {
    getCacheStatistics,
    clearCacheByPattern,
    clearAllCacheData,
    resetStatistics,
    getAllCacheKeys,
    warmPopularCache,
    renderCacheManagementPage,
};
