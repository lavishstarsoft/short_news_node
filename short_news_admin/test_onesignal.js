require('dotenv').config();

const oneSignalService = require('./services/oneSignalService');

// Wait a moment for the service to initialize
setTimeout(async () => {
  try {
    console.log('Testing OneSignal service...');
    
    // Test sending a simple notification
    const response = await oneSignalService.sendNotificationToAll(
      'Test Notification',
      'This is a test notification from the backend',
      {
        type: 'test',
        timestamp: new Date().toISOString()
      }
    );
    
    console.log('Notification sent successfully:', response);
  } catch (error) {
    console.error('Error sending test notification:', error);
  }
}, 2000);