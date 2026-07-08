const mongoose = require('mongoose');
const Category = require('./models/Category');
require('dotenv').config();

const categories = [
    {
        name: 'Political/Happening',
        displayName: 'Politics',
        showToReporters: true,
        order: 2,
        showInApp: true,
        description: 'Political news and happening events',
        color: '#F44336', // Red
        icon: 'account_balance',
        isActive: true
    },
    {
        name: 'Administration/Infra',
        displayName: 'News',
        showToReporters: true,
        order: 1,
        showInApp: true,
        description: 'Administration and infrastructure news',
        color: '#607D8B', // BlueGrey
        icon: 'business_center',
        isActive: true
    },
    {
        name: 'Crime/Accident',
        displayName: 'News',
        showToReporters: true,
        order: 1,
        showInApp: true,
        description: 'Crime and accident news',
        color: '#dc3545', // Red
        icon: 'gavel',
        isActive: true
    },
    {
        name: 'Event/Sports',
        displayName: 'Sports',
        showToReporters: true,
        order: 4,
        showInApp: true,
        description: 'Event and sports news',
        color: '#FF5722', // DeepOrange
        icon: 'emoji_events',
        isActive: true
    },
    {
        name: 'Issues',
        displayName: 'Special',
        showToReporters: true,
        order: 6,
        showInApp: true,
        description: 'Public issues and protests',
        color: '#ffc107', // Amber
        icon: 'report_problem',
        isActive: true
    },
    {
        name: 'Movies',
        displayName: 'Movies',
        showToReporters: false,
        order: 5,
        showInApp: true,
        description: 'Movies and entertainment',
        color: '#9C27B0', // Purple
        icon: 'movie',
        isActive: true
    },
    {
        name: 'Special',
        displayName: 'Special',
        showToReporters: false,
        order: 6,
        showInApp: true,
        description: 'Special news and features',
        color: '#ffc107', // Amber
        icon: 'star',
        isActive: true
    },
    {
        name: 'Business',
        displayName: 'Business',
        showToReporters: false,
        order: 3,
        showInApp: true,
        description: 'Business and finance news',
        color: '#2196F3', // Blue
        icon: 'trending_up',
        isActive: true
    },
    {
        name: 'Health & Fitness',
        displayName: 'Health & Fitness',
        showToReporters: false,
        order: 7,
        showInApp: true,
        description: 'Health, wellness, and fitness tips',
        color: '#20c997', // Teal
        icon: 'health_and_safety',
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
