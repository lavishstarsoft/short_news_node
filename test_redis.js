const { redisClient, isRedisAvailable } = require('./config/redis');

async function testRedis() {
    console.log('=== Redis Connection Test ===\n');

    // Wait a bit for connection to establish
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Test 1: Check connection status
    console.log('1. Connection Status:');
    console.log('   - Redis Available:', isRedisAvailable());
    console.log('   - Redis Ready:', redisClient.isReady);
    console.log('   - Redis Connected:', redisClient.isOpen);

    if (!isRedisAvailable()) {
        console.log('\n❌ Redis is not available. Exiting...');
        process.exit(1);
    }

    try {
        // Test 2: Basic SET/GET operations
        console.log('\n2. Basic SET/GET Test:');
        await redisClient.set('test:key', 'Hello Redis!');
        const value = await redisClient.get('test:key');
        console.log('   - SET test:key = "Hello Redis!"');
        console.log('   - GET test:key =', value);
        console.log('   - Test Result:', value === 'Hello Redis!' ? '✅ PASSED' : '❌ FAILED');

        // Test 3: SET with expiration
        console.log('\n3. SET with Expiration Test:');
        await redisClient.setEx('test:expire', 5, 'Expires in 5 seconds');
        const expValue = await redisClient.get('test:expire');
        const ttl = await redisClient.ttl('test:expire');
        console.log('   - SET test:expire with 5s TTL');
        console.log('   - GET test:expire =', expValue);
        console.log('   - TTL remaining:', ttl, 'seconds');
        console.log('   - Test Result:', expValue === 'Expires in 5 seconds' && ttl > 0 && ttl <= 5 ? '✅ PASSED' : '❌ FAILED');

        // Test 4: JSON data storage
        console.log('\n4. JSON Data Storage Test:');
        const testData = {
            id: 1,
            title: 'Test News',
            likes: 10,
            timestamp: new Date().toISOString()
        };
        await redisClient.setEx('cache:/api/public/news', 300, JSON.stringify(testData));
        const cachedData = await redisClient.get('cache:/api/public/news');
        const parsedData = JSON.parse(cachedData);
        console.log('   - Stored:', testData);
        console.log('   - Retrieved:', parsedData);
        console.log('   - Test Result:', parsedData.id === testData.id ? '✅ PASSED' : '❌ FAILED');

        // Test 5: KEYS pattern matching
        console.log('\n5. KEYS Pattern Matching Test:');
        await redisClient.set('cache:/api/news/1', 'news1');
        await redisClient.set('cache:/api/news/2', 'news2');
        await redisClient.set('cache:/api/categories', 'categories');
        const keys = await redisClient.keys('cache:/api/news*');
        console.log('   - Created keys: cache:/api/news/1, cache:/api/news/2, cache:/api/categories');
        console.log('   - KEYS cache:/api/news* =', keys);
        console.log('   - Test Result:', keys.length === 2 ? '✅ PASSED' : '❌ FAILED');

        // Test 6: DELETE operation
        console.log('\n6. DELETE Test:');
        const delCount = await redisClient.del(keys);
        const afterDel = await redisClient.keys('cache:/api/news*');
        console.log('   - Deleted', delCount, 'keys');
        console.log('   - Remaining keys matching pattern:', afterDel.length);
        console.log('   - Test Result:', afterDel.length === 0 ? '✅ PASSED' : '❌ FAILED');

        // Test 7: FLUSHALL (clear all)
        console.log('\n7. FLUSHALL Test:');
        await redisClient.set('test:cleanup1', 'value1');
        await redisClient.set('test:cleanup2', 'value2');
        await redisClient.flushAll();
        const allKeys = await redisClient.keys('*');
        console.log('   - Cleared all keys');
        console.log('   - Remaining keys:', allKeys.length);
        console.log('   - Test Result:', allKeys.length === 0 ? '✅ PASSED' : '❌ FAILED');

        console.log('\n=== All Tests Completed ===\n');

    } catch (error) {
        console.error('\n❌ Error during testing:', error);
        process.exit(1);
    }

    // Clean up and exit
    await redisClient.quit();
    console.log('✅ Redis connection closed');
    process.exit(0);
}

testRedis();
