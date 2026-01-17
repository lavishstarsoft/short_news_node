require('dotenv').config();
const oneSignalService = require('./services/oneSignalService');

async function testNewsNotification() {
  try {
    console.log('Testing news notification functionality...');
    
    // Test sending a notification for a specific news item
    const response = await oneSignalService.sendAdminNotification(
      'Breaking News: Test Article',
      'This is a test news article notification',
      {
        newsId: 'test-news-id-123',
        imageUrl: 'https://example.com/news-image.jpg',
        type: 'admin'
      }
    );
    
    console.log('News notification sent successfully:', response);
  } catch (error) {
    console.error('Error testing news notification:', error);
  }
}

// Run the test
testNewsNotification();