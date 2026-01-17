require('dotenv').config();

async function testOneSignalAPI() {
  try {
    console.log('Testing OneSignal API directly...');
    
    const appId = process.env.ONESIGNAL_APP_ID;
    const apiKey = process.env.ONESIGNAL_API_KEY;
    
    console.log('App ID:', appId);
    console.log('API Key length:', apiKey ? apiKey.length : 'NOT SET');
    
    if (!appId || !apiKey) {
      console.error('Missing App ID or API Key');
      return;
    }
    
    // Test the API by sending a simple notification
    const response = await fetch('https://api.onesignal.com/notifications', {
      method: 'POST',
      headers: {
        'Authorization': `key ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        app_id: appId,
        contents: { en: 'Test notification' },
        headings: { en: 'Test Title' },
        included_segments: ['All']
      })
    });
    
    console.log('Response status:', response.status);
    console.log('Response headers:', [...response.headers.entries()]);
    
    const responseBody = await response.text();
    console.log('Response body:', responseBody);
    
    if (response.ok) {
      console.log('API key is valid!');
    } else {
      console.error('API key is invalid or has insufficient permissions');
    }
  } catch (error) {
    console.error('Error testing OneSignal API:', error);
  }
}

testOneSignalAPI();