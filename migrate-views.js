// Migration script to add views field to existing news items
const mongoose = require('mongoose');
const News = require('./models/News');

// MongoDB connection string
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/short-news';

async function migrateNewsViews() {
    try {
        // Connect to MongoDB
        await mongoose.connect(MONGODB_URI);
        console.log('✅ Connected to MongoDB');

        // Update all news items that don't have views field
        const result = await News.updateMany(
            { views: { $exists: false } }, // Find news without views field
            { $set: { views: 0 } } // Set views to 0
        );

        console.log(`✅ Migration completed!`);
        console.log(`   Updated ${result.modifiedCount} news items`);
        console.log(`   Matched ${result.matchedCount} news items`);

        // Disconnect from MongoDB
        await mongoose.disconnect();
        console.log('✅ Disconnected from MongoDB');

        process.exit(0);
    } catch (error) {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    }
}

// Run migration
migrateNewsViews();
