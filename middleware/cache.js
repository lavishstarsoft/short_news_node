const { redisClient, isRedisAvailable } = require('../config/redis');

/**
 * Cache middleware for Express routes
 * @param {number} duration - Cache duration in seconds (default: 300 = 5 minutes)
 * @returns {Function} Express middleware function
 */
const cacheMiddleware = (duration = 300) => {
    return async (req, res, next) => {
        // Skip caching if Redis is not available
        if (!isRedisAvailable()) {
            console.log('⚠️  Redis not available, skipping cache');
            return next();
        }

        // Generate cache key from request URL and query params
        const key = `cache:${req.originalUrl || req.url}`;

        try {
            // Try to get cached data
            const cachedData = await redisClient.get(key);

            if (cachedData) {
                // Cache hit - return cached data immediately
                console.log(`⚡ Cache HIT for ${key}`);
                const data = JSON.parse(cachedData);
                return res.json(data);
            }

            // Cache miss - continue to route handler
            console.log(`💾 Cache MISS for ${key}`);

            // Store original res.json function
            const originalJson = res.json.bind(res);

            // Override res.json to cache the response
            res.json = function (data) {
                // Cache the response data
                redisClient
                    .setEx(key, duration, JSON.stringify(data))
                    .then(() => {
                        console.log(`💾 Cached data for ${key} (expires in ${duration}s)`);
                    })
                    .catch((err) => {
                        console.error(`❌ Failed to cache data for ${key}:`, err.message);
                    });

                // Call original res.json
                return originalJson(data);
            };

            next();
        } catch (error) {
            console.error('❌ Cache middleware error:', error.message);
            // On error, skip cache and continue
            next();
        }
    };
};

/**
 * Clear cache by pattern
 * @param {string} pattern - Redis key pattern (e.g., 'cache:/api/public/news*')
 */
const clearCache = async (pattern) => {
    if (!isRedisAvailable()) {
        console.log('⚠️  Redis not available, cannot clear cache');
        return;
    }

    try {
        // Find all keys matching the pattern
        const keys = await redisClient.keys(pattern);

        if (keys.length > 0) {
            // Delete all matching keys
            await redisClient.del(keys);
            console.log(`🗑️  Cleared ${keys.length} cache entries matching: ${pattern}`);
        } else {
            console.log(`📭 No cache entries found for pattern: ${pattern}`);
        }
    } catch (error) {
        console.error('❌ Error clearing cache:', error.message);
    }
};

/**
 * Clear all cache
 */
const clearAllCache = async () => {
    if (!isRedisAvailable()) {
        console.log('⚠️  Redis not available, cannot clear cache');
        return;
    }

    try {
        await redisClient.flushAll();
        console.log('🗑️  Cleared all cache');
    } catch (error) {
        console.error('❌ Error clearing all cache:', error.message);
    }
};

module.exports = {
    cacheMiddleware,
    clearCache,
    clearAllCache,
};
