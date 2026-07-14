const mongoose = require('mongoose');
require('dotenv').config();

async function run() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('Connected to MongoDB.');

    const db = mongoose.connection.db;
    const usersCollection = db.collection('users');

    // List all indexes
    const indexes = await usersCollection.indexes();
    console.log('Current indexes on users collection:');
    indexes.forEach(idx => console.log(' - ' + idx.name));

    // Check if referralCode_1 exists and drop it
    const indexName = 'referralCode_1';
    const indexExists = indexes.some(idx => idx.name === indexName);
    
    if (indexExists) {
      console.log(`Dropping unique index: ${indexName}...`);
      await usersCollection.dropIndex(indexName);
      console.log('Index dropped successfully.');
    } else {
      console.log(`Index ${indexName} not found. Safe to proceed.`);
    }

  } catch (error) {
    console.error('Error dropping index:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected.');
  }
}

run();
