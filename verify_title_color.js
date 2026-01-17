require('dotenv').config();
const OneSignal = require('@onesignal/node-onesignal');

// Initialize OneSignal client
const configuration = OneSignal.createConfiguration({
  restApiKey: process.env.ONESIGNAL_API_KEY,
  basePath: 'https://api.onesignal.com'
});

const client = new OneSignal.DefaultApi(configuration);
const appId = process.env.ONESIGNAL_APP_ID;

async function verifyTitleColor() {
  try {
    console.log('Verifying title color functionality...');
    
    // Create a notification with title color
    const notification = new OneSignal.Notification();
    notification.app_id = appId;
    notification.contents = { en: 'This is a test notification with title color' };
    notification.headings = { en: 'Test Title Color Notification' };
    notification.data = {
      type: 'admin',
      titleColor: '#FF0000' // Red color
    };
    notification.included_segments = ['All'];
    
    // Set the accent color
    notification.android_accent_color = 'FFFF0000'; // Red color in ARGB format
    
    console.log('Sending notification with accent color:', notification.android_accent_color);
    
    const response = await client.createNotification(notification);
    console.log('Notification sent successfully:', response);
    
  } catch (error) {
    console.error('Error verifying title color:', error);
    
    // Log the error body if available
    if (error.body) {
      error.body.text().then(text => {
        console.error('Error body:', text);
      }).catch(err => {
        console.error('Error reading error body:', err);
      });
    }
  }
}

// Run the verification
verifyTitleColor();