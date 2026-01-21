require('dotenv').config();
const { redisClient } = require('../config/redis');

async function clearCache() {
    console.log('Redis client state:', redisClient.isOpen ? 'OPEN' : 'CLOSED');

    if (!redisClient.isOpen) {
        try {
            console.log('Connecting to Redis...');
            await redisClient.connect();
        } catch (error) {
            if (error.message.includes('Socket already opened')) {
                console.log('Socket was already open (race condition), proceeding...');
            } else {
                throw error;
            }
        }
    }

    console.log('Connected. Flushing all...');
    await redisClient.flushAll();
    console.log('Cache cleared.');
    process.exit(0);
}

// Give it a moment to initialize config
setTimeout(() => {
    clearCache().catch(err => {
        console.error('Error:', err);
        process.exit(1);
    });
}, 1000);
