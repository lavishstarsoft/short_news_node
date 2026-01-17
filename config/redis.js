const redis = require('redis');

// Cache statistics tracking
const cacheStats = {
  hits: 0,
  misses: 0,
  errors: 0,
  lastReset: new Date(),
};

// Create Redis client with enhanced configuration
const redisClient = redis.createClient({
  socket: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    reconnectStrategy: (retries) => {
      // Exponential backoff: 50ms, 100ms, 200ms, 400ms, 800ms, max 3000ms
      const delay = Math.min(50 * Math.pow(2, retries), 3000);
      console.log(`⏳ Redis reconnection attempt ${retries + 1}, waiting ${delay}ms...`);
      return delay;
    },
    connectTimeout: 10000, // 10 second connection timeout
  },
  // Add password if using production Redis
  password: process.env.REDIS_PASSWORD || undefined,
});

// Track connection status
let isConnected = false;
let connectionAttempts = 0;

// Connection event handlers
redisClient.on('connect', () => {
  connectionAttempts++;
  console.log(`✅ Redis client connected successfully (attempt ${connectionAttempts})`);
});

redisClient.on('ready', () => {
  isConnected = true;
  console.log('✅ Redis client ready to use');
  console.log(`🚀 Redis connection established at ${new Date().toISOString()}`);

  // Log connection details
  console.log(`📍 Redis host: ${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`);
});

redisClient.on('error', (err) => {
  cacheStats.errors++;
  console.error('❌ Redis error:', err.message);
  console.log('⚠️  App will continue without caching');
  isConnected = false;
});

redisClient.on('end', () => {
  console.log(`🔌 Redis client disconnected at ${new Date().toISOString()}`);
  isConnected = false;
});

redisClient.on('reconnecting', () => {
  console.log('🔄 Redis client attempting to reconnect...');
});

// Connect to Redis immediately
redisClient.connect().catch((err) => {
  console.error('❌ Failed to connect to Redis:', err.message);
  console.log('⚠️  Running without Redis cache - performance will be slower');
  isConnected = false;
});

// Helper function to check if Redis is available
const isRedisAvailable = () => {
  return isConnected && redisClient.isReady;
};

// Track cache hit
const recordCacheHit = () => {
  cacheStats.hits++;
};

// Track cache miss
const recordCacheMiss = () => {
  cacheStats.misses++;
};

// Get cache statistics
const getCacheStats = async () => {
  if (!isRedisAvailable()) {
    return {
      available: false,
      message: 'Redis is not available',
    };
  }

  try {
    const info = await redisClient.info('stats');
    const memory = await redisClient.info('memory');
    const keyspace = await redisClient.info('keyspace');

    // Parse keyspace to get key count
    let totalKeys = 0;
    const keyspaceMatch = keyspace.match(/keys=(\d+)/);
    if (keyspaceMatch) {
      totalKeys = parseInt(keyspaceMatch[1], 10);
    }

    // Calculate hit rate
    const totalRequests = cacheStats.hits + cacheStats.misses;
    const hitRate = totalRequests > 0 ? (cacheStats.hits / totalRequests * 100).toFixed(2) : 0;

    return {
      available: true,
      connected: isConnected,
      hits: cacheStats.hits,
      misses: cacheStats.misses,
      errors: cacheStats.errors,
      hitRate: `${hitRate}%`,
      totalKeys,
      uptime: process.uptime(),
      lastReset: cacheStats.lastReset,
      memoryInfo: memory.split('\r\n').filter(line =>
        line.includes('used_memory_human') ||
        line.includes('used_memory_peak_human')
      ).join(', '),
    };
  } catch (error) {
    console.error('Error getting cache stats:', error);
    return {
      available: true,
      connected: isConnected,
      hits: cacheStats.hits,
      misses: cacheStats.misses,
      errors: cacheStats.errors,
      error: error.message,
    };
  }
};

// Reset cache statistics
const resetCacheStats = () => {
  cacheStats.hits = 0;
  cacheStats.misses = 0;
  cacheStats.errors = 0;
  cacheStats.lastReset = new Date();
  console.log('📊 Cache statistics reset');
};

// Cache warming - pre-load popular data
const warmCache = async (dataLoader) => {
  if (!isRedisAvailable()) {
    console.log('⚠️  Cannot warm cache - Redis not available');
    return false;
  }

  try {
    console.log('🔥 Starting cache warming...');
    const data = await dataLoader();
    console.log(`✅ Cache warmed with ${data.length || 0} items`);
    return true;
  } catch (error) {
    console.error('❌ Error warming cache:', error.message);
    return false;
  }
};

// Graceful shutdown
const closeRedisConnection = async () => {
  if (isRedisAvailable()) {
    try {
      await redisClient.quit();
      console.log('✅ Redis connection closed gracefully');
    } catch (error) {
      console.error('❌ Error closing Redis connection:', error.message);
      await redisClient.disconnect();
    }
  }
};

module.exports = {
  redisClient,
  isRedisAvailable,
  recordCacheHit,
  recordCacheMiss,
  getCacheStats,
  resetCacheStats,
  warmCache,
  closeRedisConnection,
};
