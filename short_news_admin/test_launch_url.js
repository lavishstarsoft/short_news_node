require('dotenv').config();
const oneSignalService = require('./services/oneSignalService');

async function testLaunchUrl() {
  try {
    console.log('Testing Launch URL functionality...');
    
    // Test sending a notification with a Launch URL
    const response = await oneSignalService.sendAdminNotification(
      'Test Launch URL Notification',
      'This notification should open a URL when tapped',
      {
        launchUrl: 'https://www.example.com',
        type: 'admin'
      }
    );
    
    console.log('Notification sent successfully:', response);
  } catch (error) {
    console.error('Error testing Launch URL:', error);
  }
}

async function testTitleColor() {
  try {
    console.log('Testing Title Color functionality...');
    
    // Test sending a notification with a custom title color
    const response = await oneSignalService.sendAdminNotification(
      'Test Title Color Notification',
      'This notification should have a red title',
      {
        titleColor: '#FF0000', // Red color
        type: 'admin'
      }
    );
    
    console.log('Notification sent successfully:', response);
  } catch (error) {
    console.error('Error testing Title Color:', error);
  }
}

async function testTitleColorWithAccent() {
  try {
    console.log('Testing Title Color with Accent functionality...');
    
    // Test sending a notification with a custom title color and accent color
    const response = await oneSignalService.sendAdminNotification(
      'Test Title Color with Accent Notification',
      'This notification should have a blue title and green accent',
      {
        titleColor: '#0000FF', // Blue color for title
        type: 'admin'
      }
    );
    
    console.log('Notification sent successfully:', response);
  } catch (error) {
    console.error('Error testing Title Color with Accent:', error);
  }
}

// Run the tests
async function runTests() {
  await testLaunchUrl();
  await testTitleColor();
  await testTitleColorWithAccent();
}

runTests();