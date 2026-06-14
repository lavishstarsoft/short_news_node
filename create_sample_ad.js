const mongoose = require('mongoose');
require('dotenv').config();

// Import the Ad model
const Ad = require('./models/Ad');

// MongoDB connection
const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) { console.error('MONGODB_URI not set. Aborting.'); process.exit(1); }

mongoose.connect(mongoUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(async () => {
  console.log('Connected to MongoDB successfully');
  
  // Create a sample ad
  const sampleAd = new Ad({
    title: 'Sample Ad',
    content: 'This is a sample advertisement for testing purposes',
    imageUrl: '/uploads/sample-ad.jpg',
    linkUrl: 'https://example.com',
    isActive: true,
    author: 'Test Admin',
    authorId: 'test_admin_123',
    positionInterval: 3
  });
  
  try {
    const savedAd = await sampleAd.save();
    console.log('Sample ad created successfully:', savedAd);
  } catch (error) {
    console.error('Error creating sample ad:', error);
  } finally {
    mongoose.connection.close();
  }
})
.catch((err) => {
  console.error('Failed to connect to MongoDB:', err.message);
});