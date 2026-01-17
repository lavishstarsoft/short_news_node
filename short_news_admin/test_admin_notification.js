require('dotenv').config();
const jwt = require('jsonwebtoken');

async function testAdminNotification() {
  try {
    console.log('Testing admin notification API...');
    
    // Generate a JWT token for the superadmin user
    const token = jwt.sign(
      { id: '68e388b4463f99e268b5d4af', username: 'superadmin', role: 'superadmin' },
      process.env.JWT_SECRET || 'short_news_secret_key',
      { expiresIn: '24h' }
    );
    
    console.log('Generated token:', token);
    
    // Send a test notification
    const response = await fetch('http://localhost:3001/admin/api/send-notification', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `token=${token}`
      },
      body: JSON.stringify({
        title: 'Test Admin Notification',
        message: 'This is a test notification sent from the admin API',
        priority: 'normal'
      })
    });
    
    console.log('Response status:', response.status);
    console.log('Response headers:', [...response.headers.entries()]);
    
    const responseBody = await response.text();
    console.log('Response body:', responseBody);
    
    if (response.ok) {
      console.log('Admin notification sent successfully!');
    } else {
      console.error('Failed to send admin notification');
    }
  } catch (error) {
    console.error('Error testing admin notification API:', error);
  }
}

testAdminNotification();