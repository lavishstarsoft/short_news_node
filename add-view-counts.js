// Script to add realistic view counts to existing news items
const mongoose = require('mongoose');
const News = require('./models/News');
require('dotenv').config();

// MongoDB connection string from .env
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) { console.error('MONGODB_URI not set. Aborting.'); process.exit(1); }

async function addViewCounts() {
    try {
        // Connect to MongoDB
        await mongoose.connect(MONGODB_URI);
        console.log('✅ Connected to MongoDB');

        // Get all news items
        const newsItems = await News.find({});
        console.log(`📰 Found ${newsItems.length} news items`);

        let updated = 0;

        // Update each news item with a realistic view count
        for (const news of newsItems) {
            // Generate realistic view count
            let views;

            if (news.likes > 0) {
                // If news has likes, views should be 3-5x the number of likes
                const multiplier = Math.random() * 2 + 3; // Random between 3 and 5
                views = Math.floor((news.likes || 0) * multiplier);
            } else {
                // If no likes, give a random view count between 500 and 5000
                views = Math.floor(Math.random() * 4500) + 500;
            }

            // Update the news item
            await News.updateOne(
                { _id: news._id },
                { $set: { views: views } }
            );

            updated++;
            console.log(`   Updated "${news.title.substring(0, 50)}..." - Views: ${views} (Likes: ${news.likes || 0})`);
        }

        console.log(`\n✅ Update completed!`);
        console.log(`   Updated ${updated} news items with view counts`);

        // Disconnect from MongoDB
        await mongoose.disconnect();
        console.log('✅ Disconnected from MongoDB');

        process.exit(0);
    } catch (error) {
        console.error('❌ Update failed:', error);
        process.exit(1);
    }
}

// Run update
addViewCounts();
