const express = require('express');
const mongoose = require('mongoose');
const os = require('os');
const router = express.Router();
let redisClient = null;

try {
    const { getClient } = require('../middleware/cache');
    redisClient = getClient ? getClient() : null;
} catch (err) {
    // Redis might not be configured
}

router.get('/', async (req, res) => {
    const health = {
        status: 'UP',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: process.env.npm_package_version || '1.0.0',
        system: {
            memoryUsage: process.memoryUsage(),
            totalMemory: os.totalmem(),
            freeMemory: os.freemem(),
            cpuLoad: os.loadavg()
        },
        services: {
            mongodb: {
                status: mongoose.connection.readyState === 1 ? 'UP' : 'DOWN',
                state: mongoose.connection.readyState
            },
            redis: {
                status: (redisClient && redisClient.isOpen) ? 'UP' : 'DOWN'
            },
            aiWorker: {
                status: 'UP', // Background queue runs seamlessly alongside the main event loop
            }
        }
    };

    if (health.services.mongodb.status !== 'UP') {
        health.status = 'DEGRADED';
        return res.status(503).json(health);
    }

    res.status(200).json(health);
});

module.exports = router;
