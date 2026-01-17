require('dotenv').config();
const oneSignalService = require('./services/oneSignalService');

async function comprehensiveTest() {
  try {
    console.log('Running comprehensive notification test...');
    
    // Test 1: Notification without title color
    console.log('\n--- Test 1: Notification without title color ---');
    const response1 = await oneSignalService.sendAdminNotification(
      'Test Notification - No Color',
      'This notification should use the default title color',
      {
        type: 'admin',
        testId: 'test1'
      }
    );
    console.log('Notification sent successfully:', response1.id);
    
    // Wait a bit between tests
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Test 2: Notification with red title color
    console.log('\n--- Test 2: Notification with red title color ---');
    const response2 = await oneSignalService.sendAdminNotification(
      'Test Notification - Red Title',
      'This notification should have a red title',
      {
        titleColor: '#FF0000', // Red
        type: 'admin',
        testId: 'test2'
      }
    );
    console.log('Notification sent successfully:', response2.id);
    
    // Wait a bit between tests
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Test 3: Notification with blue title color
    console.log('\n--- Test 3: Notification with blue title color ---');
    const response3 = await oneSignalService.sendAdminNotification(
      'Test Notification - Blue Title',
      'This notification should have a blue title',
      {
        titleColor: '#0000FF', // Blue
        type: 'admin',
        testId: 'test3'
      }
    );
    console.log('Notification sent successfully:', response3.id);
    
    // Wait a bit between tests
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Test 4: Notification with green title color and launch URL
    console.log('\n--- Test 4: Notification with green title color and launch URL ---');
    const response4 = await oneSignalService.sendAdminNotification(
      'Test Notification - Green Title with URL',
      'This notification should have a green title and open a URL when tapped',
      {
        titleColor: '#00FF00', // Green
        launchUrl: 'https://www.example.com',
        type: 'admin',
        testId: 'test4'
      }
    );
    console.log('Notification sent successfully:', response4.id);
    
    console.log('\n--- All tests completed ---');
    
  } catch (error) {
    console.error('Error in comprehensive test:', error);
  }
}

// Run the comprehensive test
comprehensiveTest();