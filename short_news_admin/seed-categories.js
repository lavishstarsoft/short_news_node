const mongoose = require('mongoose');
const Category = require('./models/Category');
require('dotenv').config();

const categories = [
    {
        name: 'మీకోసం', // For You
        description: 'Personalized news for you',
        color: '#2196F3', // Blue
        icon: 'person',
        isActive: true
    },
    {
        name: 'వార్తలు', // News
        description: 'General news updates',
        color: '#FFC107', // Amber
        icon: 'article',
        isActive: true
    },
    {
        name: 'రాజకీయాలు', // Politics
        description: 'Political news and updates',
        color: '#F44336', // Red
        icon: 'account_balance',
        isActive: true
    },
    {
        name: 'వ్యాపారం', // Business
        description: 'Business and finance news',
        color: '#607D8B', // BlueGrey
        icon: 'business_center',
        isActive: true
    },
    {
        name: 'క్రీడలు', // Sports
        description: 'Sports news',
        color: '#FF5722', // DeepOrange
        icon: 'emoji_events',
        isActive: true
    },
    {
        name: 'సినిమా', // Cinema
        description: 'Movies and entertainment',
        color: '#9C27B0', // Purple
        icon: 'movie',
        isActive: true
    }
];

const seedCategories = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        console.log('✅ Connected to MongoDB');

        // Clear existing categories carefully or just upsert
        // For this task, let's clear to ensure exact match with UI requirement
        await Category.deleteMany({});
        console.log('🗑️ Cleared existing categories');

        for (const cat of categories) {
            await Category.create(cat);
            console.log(`✨ Created category: ${cat.name}`);
        }

        console.log('✅ All categories seeded successfully!');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error seeding categories:', error);
        process.exit(1);
    }
};

seedCategories();
