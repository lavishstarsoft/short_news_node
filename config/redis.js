const redis = require('redis');

// Redis client configuration
const redisClient = redis.createClient({
  socket: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
  },
  // Add password if using production Redis
  // password: process.env.REDIS_PASSWORD,
});

// Connection event handlers
redisClient.on('connect', () => {
  console.log('✅ Redis client connected successfully');
});

redisClient.on('ready', () => {
  console.log('✅ Redis client ready to use');
});

redisClient.on('error', (err) => {
  console.error('❌ Redis error:', err.message);
  console.log('⚠️  App will continue without caching');
});

redisClient.on('end', () => {
  console.log('🔌 Redis client disconnected');
});

// Connect to Redis
let isRedisConnected = false;

(async () => {
  try {
    await redisClient.connect();
    isRedisConnected = true;
    console.log('🚀 Redis connection established');
  } catch (err) {
    console.error('❌ Failed to connect to Redis:', err.message);
    console.log('⚠️  Running without Redis cache - performance will be slower');
    isRedisConnected = false;
  }
})();

// Helper function to check if Redis is available
const isRedisAvailable = () => {
  return isRedisConnected && redisClient.isReady;
};

module.exports = {
  redisClient,
  isRedisAvailable,
};
