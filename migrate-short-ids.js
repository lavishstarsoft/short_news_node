const mongoose = require('mongoose');
require('dotenv').config();
const News = require('./models/News');

async function migrate() {
    try {
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/short_news');
        console.log('Connected to MongoDB');

        const newsItems = await News.find({ shortId: { $exists: false } });
        console.log(`Found ${newsItems.length} news items without shortId`);

        let updatedCount = 0;
        for (const news of newsItems) {
            const idStr = news._id.toString();
            news.shortId = idStr.substring(idStr.length - 6);
            await news.save();
            updatedCount++;
            if (updatedCount % 10 === 0) {
                console.log(`Updated ${updatedCount}/${newsItems.length} items...`);
            }
        }

        console.log(`Migration completed. ${updatedCount} items updated.`);
        process.exit(0);
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
}

migrate();
