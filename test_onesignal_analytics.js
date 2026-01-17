require('dotenv').config();
const jwt = require('jsonwebtoken');

async function testOneSignalAnalytics() {
  try {
    console.log('Testing OneSignal analytics API...');
    
    // Generate a JWT token for the superadmin user
    const token = jwt.sign(
      { id: '68e388b4463f99e268b5d4af', username: 'superadmin', role: 'superadmin' },
      process.env.JWT_SECRET || 'short_news_secret_key',
      { expiresIn: '24h' }
    );
    
    console.log('Generated token:', token);
    
    // Test the OneSignal analytics API
    const response = await fetch('http://localhost:3001/admin/api/onesignal/analytics', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `token=${token}`
      }
    });
    
    console.log('Response status:', response.status);
    console.log('Response headers:', [...response.headers.entries()]);
    
    const responseBody = await response.text();
    console.log('Response body:', responseBody);
    
    if (response.ok) {
      console.log('OneSignal analytics retrieved successfully!');
    } else {
      console.error('Failed to retrieve OneSignal analytics');
    }
  } catch (error) {
    console.error('Error testing OneSignal analytics API:', error);
  }
}

testOneSignalAnalytics();