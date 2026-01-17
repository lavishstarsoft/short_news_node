require('dotenv').config();
const oneSignalService = require('./services/oneSignalService');

async function testLedSettings() {
  try {
    console.log('Testing LED settings functionality...');
    
    // Test sending a notification with LED settings
    const response = await oneSignalService.sendAdminNotification(
      'Test LED Notification',
      'This notification should have LED settings configured',
      {
        platformSettings: {
          android: {
            icon: 'ic_stat_onesignal_default',
            lights: true,
            ledOnMs: 1000,
            ledOffMs: 1000
          }
        },
        type: 'admin'
      }
    );
    
    console.log('Notification sent successfully:', response);
  } catch (error) {
    console.error('Error testing LED settings:', error);
  }
}

// Run the test
testLedSettings();