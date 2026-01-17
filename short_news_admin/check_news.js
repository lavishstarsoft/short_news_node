const mongoose = require('mongoose');
require('dotenv').config();

// Import models
const News = require('./models/News');
const Location = require('./models/Location');

// MongoDB connection
const mongoUri = process.env.MONGODB_URI || 'mongodb+srv://ashokca810:ashokca810@cluster0.psirpqa.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';

mongoose.connect(mongoUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(async () => {
  console.log('Connected to MongoDB successfully');
  
  // Get all news articles
  const newsList = await News.find();
  console.log('Total news articles:', newsList.length);
  
  // Display news articles with their locations
  newsList.forEach(news => {
    console.log(`Title: ${news.title}, Location: ${news.location || 'None'}`);
  });
  
  // Get all locations
  const locations = await Location.find();
  console.log('\nTotal locations:', locations.length);
  
  // Display locations with their names
  locations.forEach(location => {
    console.log(`Location: ${location.name}, Code: ${location.code}`);
  });
  
  // Calculate news count for each location
  console.log('\nNews count per location:');
  for (const location of locations) {
    const newsCount = await News.countDocuments({ location: location.name });
    console.log(`${location.name}: ${newsCount} news articles`);
  }
  
  // Disconnect from MongoDB
  mongoose.disconnect();
  console.log('\nDisconnected from MongoDB');
})
.catch((err) => {
  console.log('Failed to connect to MongoDB:', err.message);
});