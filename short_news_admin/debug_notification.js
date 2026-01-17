require('dotenv').config();
const oneSignalService = require('./services/oneSignalService');

async function debugNotification() {
  try {
    console.log('Debugging notification data...');
    
    // Test sending a notification with title color
    const title = 'Debug Title Color Notification';
    const message = 'This is a debug notification to check title color';
    const data = {
      titleColor: '#FF0000', // Red color
      type: 'admin',
      debug: true
    };
    
    console.log('Sending notification with data:', { title, message, data });
    
    // Send the notification
    const response = await oneSignalService.sendAdminNotification(title, message, data);
    
    console.log('Notification sent successfully:', response);
  } catch (error) {
    console.error('Error debugging notification:', error);
  }
}

// Run the debug
debugNotification();