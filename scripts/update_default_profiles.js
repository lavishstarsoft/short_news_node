require('dotenv').config();
const mongoose = require('mongoose');
const Admin = require('../models/Admin');

async function updateProfiles() {
    try {
        await mongoose.connect(process.env.MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            serverSelectionTimeoutMS: 50000,
            socketTimeoutMS: 45000,
        });

        console.log('Connected to MongoDB.');

        const result = await Admin.updateMany(
            { 
                role: { $in: ['editor', 'subeditor'] },
                $or: [
                    { profileImage: null },
                    { profileImage: '' }
                ]
            },
            { $set: { profileImage: '/images/default_user_icon.png' } }
        );

        console.log(`Updated ${result.modifiedCount} records (matched ${result.matchedCount}).`);
    } catch (error) {
        console.error('Error updating profiles:', error);
    } finally {
        await mongoose.disconnect();
        console.log('Disconnected from MongoDB.');
    }
}

updateProfiles();
