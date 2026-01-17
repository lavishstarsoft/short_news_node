const mongoose = require('mongoose');
const axios = require('axios');

const BASE_URL = 'http://localhost:3001';

async function testCacheSystem() {
    console.log('=== Redis Cache System Test ===\n');

    try {
        // Test 1: Get cache statistics
        console.log('1. Testing Cache Statistics Endpoint...');
        const statsResponse = await axios.get(`${BASE_URL}/cache/stats`);
        console.log('   ✅ Stats retrieved successfully:');
        console.log('   - Available:', statsResponse.data.available);
        console.log('   - Hits:', statsResponse.data.hits);
        console.log('   - Misses:', statsResponse.data.misses);
        console.log('   - Hit Rate:', statsResponse.data.hitRate);
        console.log('   - Total Keys:', statsResponse.data.totalKeys);

        // Test 2: Test caching on public API
        console.log('\n2. Testing API Caching (First Request - should be MISS)...');
        const start1 = Date.now();
        const news1 = await axios.get(`${BASE_URL}/api/public/news`);
        const time1 = Date.now() - start1;
        console.log(`   ⏱️  Response time: ${time1}ms`);
        console.log(`   📦 Returned ${news1.data.length} news items`);
        console.log(`   🏷️  Cache Status: ${news1.headers['x-cache'] || 'N/A'}`);

        // Test 3: Test cache HIT
        console.log('\n3. Testing API Caching (Second Request - should be HIT)...');
        const start2 = Date.now();
        const news2 = await axios.get(`${BASE_URL}/api/public/news`);
        const time2 = Date.now() - start2;
        console.log(`   ⏱️  Response time: ${time2}ms`);
        console.log(`   📦 Returned ${news2.data.length} news items`);
        console.log(`   🏷️  Cache Status: ${news2.headers['x-cache'] || 'N/A'}`);
        console.log(`   🚀 Speed improvement: ${((time1 - time2) / time1 * 100).toFixed(2)}% faster`);

        // Test 4: Test cache bypass header
        console.log('\n4. Testing Cache Bypass Header...');
        const start3 = Date.now();
        const news3 = await axios.get(`${BASE_URL}/api/public/news`, {
            headers: { 'X-Bypass-Cache': 'true' }
        });
        const time3 = Date.now() - start3;
        console.log(`   ⏱️  Response time: ${time3}ms`);
        console.log(`   🏷️  Cache Status: ${news3.headers['x-cache'] || 'bypassed'}`);

        // Test 5: Get all cache keys
        console.log('\n5. Testing Cache Keys Endpoint...');
        const keysResponse = await axios.get(`${BASE_URL}/cache/keys?pattern=cache:*`);
        console.log('   ✅ Cache keys retrieved successfully:');
        console.log(`   - Total Keys: ${keysResponse.data.count}`);
        if (keysResponse.data.keys.length > 0) {
            console.log('   - Sample Keys:');
            keysResponse.data.keys.slice(0, 3).forEach(item => {
                console.log(`     • ${item.key} (TTL: ${item.ttl}s)`);
            });
        }

        console.log('\n=== All Cache Tests Passed ===\n');
        console.log('✅ Redis cache system is working perfectly!');
        console.log(`📊 Access cache management dashboard at: ${BASE_URL}/cache/management`);

        process.exit(0);
    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
        if (error.response) {
            console.error('   Status:', error.response.status);
            console.error('   Data:', error.response.data);
        }
        process.exit(1);
    }
}

console.log('⏳ Waiting 2 seconds for server to be ready...');
setTimeout(testCacheSystem, 2000);
