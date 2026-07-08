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

        // Mappings from previous categories (both English and Telugu) to the new 6 English categories
        const mappings = [
            { old: ['politics', 'political', 'రాజకీయాలు', 'Political/Happening'], new: 'Politics' },
            { old: ['Business', 'business', 'వ్యాపారం', 'Administration/Infra'], new: 'Business' },
            { old: ['Sports', 'sports', 'క్రీడలు', 'Event/Sports'], new: 'Sports' },
            { old: ['Movies', 'movies', 'சிనిమా', 'సినిమాలు', 'Entertainment', 'entertainment', 'Cinema', 'cinema'], new: 'Movies' },
            { old: ['news', 'News', 'Crime', 'crime', 'వార్తలు'], new: 'News' },
            { old: ['Devotional', 'devotional', 'Education', 'education', 'Health', 'health', 'SIMPLE TIPS', 'simple tips', 'Simple Tips', 'simple Tips', 'Issues', 'ప్రత్యేకం'], new: 'Special' }
        ];

        for (const map of mappings) {
            const result = await News.updateMany(
                { category: { $in: map.old } },
                { $set: { category: map.new } }
            );
            console.log(`Updated ${result.modifiedCount} stories from [${map.old.join(', ')}] to "${map.new}"`);
        }

        console.log('✅ News category migration to English completed successfully!');
        process.exit(0);
    } catch (e) {
        console.error('❌ Error during migration:', e);
        process.exit(1);
    }
};

runMigration();
