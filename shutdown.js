// Graceful shutdown handler
process.on('SIGTERM', async () => {
    console.log('\\n🛑 SIGTERM signal received: closing HTTP server and Redis connection');

    // Close Redis connection gracefully
    await closeRedisConnection();

    // Close HTTP server
    server.close(() => {
        console.log('✅ HTTP server closed');
        process.exit(0);
    });
});

process.on('SIGINT', async () => {
    console.log('\\n🛑 SIGINT signal received: closing HTTP server and Redis connection');

    // Close Redis connection gracefully
    await closeRedisConnection();

    // Close HTTP server
    server.close(() => {
        console.log('✅ HTTP server closed');
        process.exit(0);
    });
});
