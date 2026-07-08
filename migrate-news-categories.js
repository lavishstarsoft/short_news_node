const mongoose = require('mongoose');
const News = require('./models/News');
require('dotenv').config();

const runMigration = async () => {
    try {
        const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/short_news';
        console.log('Connecting to MongoDB...');
        await mongoose.connect(mongoUri, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        console.log('Connected to MongoDB successfully.');

        // Exact mappings:
        // 1. politics + రాజకీయాలు -> రాజకీయాలు
        // 2. Business + వ్యాపారం -> వ్యాపారం
        // 3. Sports + క్రీడలు -> క్రీడలు
        // 4. Movies + సినిమా + Entertainment -> సినిమాలు
        // 5. news + వార్తలు + Crime -> వార్తలు
        // 6. Devotional + Education + Health + SIMPLE TIPS -> ప్రత్యేకమ్

        const preciseMappings = [
            { old: ['politics', 'political'], new: 'రాజకీయాలు' },
            { old: ['Business', 'business'], new: 'వ్యాపారం' },
            { old: ['Sports', 'sports'], new: 'క్రీడలు' },
            { old: ['Movies', 'movies', 'సినిమా', 'Entertainment', 'entertainment', 'Cinema', 'cinema'], new: 'సినిమాలు' },
            { old: ['news', 'News', 'Crime', 'crime'], new: 'వార్తలు' },
            { old: ['Devotional', 'devotional', 'Education', 'education', 'Health', 'health', 'SIMPLE TIPS', 'simple tips', 'Simple Tips', 'simple Tips'], new: 'ప్రత్యేకం' }
        ];

        for (const map of preciseMappings) {
            const result = await News.updateMany(
                { category: { $in: map.old } },
                { $set: { category: map.new } }
            );
            console.log(`Updated ${result.modifiedCount} stories from [${map.old.join(', ')}] to "${map.new}"`);
        }

        console.log('✅ News category migration completed successfully!');
        process.exit(0);
    } catch (e) {
        console.error('❌ Error during migration:', e);
        process.exit(1);
    }
};

runMigration();
