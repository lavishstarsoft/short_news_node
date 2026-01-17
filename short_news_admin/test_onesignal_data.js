const oneSignalService = require('./services/oneSignalService');

async function testOneSignalData() {
  try {
    console.log('Testing OneSignal data retrieval...');
    
    // Get recent notifications
    const notifications = await oneSignalService.getNotifications(5, 0);
    console.log('Recent notifications:', JSON.stringify(notifications, null, 2));
    
    // Get app details
    const appDetails = await oneSignalService.getAppDetails();
    console.log('App details:', JSON.stringify(appDetails, null, 2));
    
  } catch (error) {
    console.error('Error testing OneSignal data:', error);
  }
}

testOneSignalData();