require('dotenv').config();
const oneSignalService = require('./services/oneSignalService');

async function testSmallIcon() {
  try {
    console.log('Testing small icon functionality...');
    
    // Test sending a notification with a small icon
    const response = await oneSignalService.sendAdminNotification(
      'Test Small Icon Notification',
      'This notification should display a small icon',
      {
        platformSettings: {
          android: {
            icon: 'ic_stat_onesignal_default'
          }
        },
        type: 'admin'
      }
    );
    
    console.log('Notification sent successfully:', response);
  } catch (error) {
    console.error('Error testing small icon:', error);
  }
}

// Run the test
testSmallIcon();