const { redisClient, isRedisAvailable, recordCacheHit, recordCacheMiss } = require('../config/redis');

/**
 * Generate consistent cache key for GraphQL queries
 * @param {string} queryName - Name of the GraphQL query
 * @param {object} variables - Query variables
 * @returns {string} Cache key
 */
function generateCacheKey(queryName, variables = {}) {
    // Sort variables for consistent key generation
    const sortedVars = JSON.stringify(variables, Object.keys(variables).sort());
    return `graphql:${queryName}:${sortedVars}`;
}

/**
 * Get cached data from Redis
 * @param {string} queryName - Name of the GraphQL query
 * @param {object} variables - Query variables
 * @returns {Promise<any|null>} Cached data or null if not found
 */
async function getCachedData(queryName, variables = {}) {
    if (!isRedisAvailable()) {
        return null;
    }

    try {
        const key = generateCacheKey(queryName, variables);
        const cached = await redisClient.get(key);

        if (cached) {
            recordCacheHit();
            console.log(`⚡ GraphQL Cache HIT: ${queryName}`);
            return JSON.parse(cached);
        }

        recordCacheMiss();
        console.log(`💾 GraphQL Cache MISS: ${queryName}`);
        return null;
    } catch (error) {
        console.error(`❌ Error getting GraphQL cache for ${queryName}:`, error.message);
        return null;
    }
}

/**
 * Set cached data in Redis
 * @param {string} queryName - Name of the GraphQL query
 * @param {object} variables - Query variables
 * @param {any} data - Data to cache
 * @param {number} ttl - Time to live in seconds (default: 300 = 5 minutes)
 */
async function setCachedData(queryName, variables = {}, data, ttl = 300) {
    if (!isRedisAvailable()) {
        return;
    }

    try {
        const key = generateCacheKey(queryName, variables);
        await redisClient.setEx(key, ttl, JSON.stringify(data));
        console.log(`💾 GraphQL Cached: ${queryName} (expires in ${ttl}s)`);
    } catch (error) {
        console.error(`❌ Error setting GraphQL cache for ${queryName}:`, error.message);
    }
}

/**
 * Invalidate cache by pattern
 * @param {string} pattern - Redis key pattern (e.g., 'graphql:news:*')
 */
async function invalidateCache(pattern) {
    if (!isRedisAvailable()) {
        return;
    }

    try {
        let keysFound = [];
        // 🚀 NON-BLOCKING: Use scanIterator instead of keys() to avoid blocking event loop
        // node-redis v4/v5 compatible
        for await (const key of redisClient.scanIterator({
            MATCH: pattern,
            COUNT: 100
        })) {
            keysFound.push(key);
            
            // Delete in batches of 100 to stay efficient
            if (keysFound.length >= 100) {
                await redisClient.del(keysFound);
                keysFound = [];
            }
        }

        // Delete remaining keys
        if (keysFound.length > 0) {
            await redisClient.del(keysFound);
        }

        console.log(`🗑️  GraphQL Cache cleared: pattern (${pattern})`);
    } catch (error) {
        console.error(`❌ Error invalidating GraphQL cache (${pattern}):`, error.message);
    }
}

/**
 * Invalidate specific item cache
 * @param {string} queryName - Query name
 * @param {string} id - Item ID
 */
async function invalidateItemCache(queryName, id) {
    await invalidateCache(`graphql:${queryName}:*${id}*`);
}

module.exports = {
    getCachedData,
    setCachedData,
    invalidateCache,
    invalidateItemCache,
    generateCacheKey
};
