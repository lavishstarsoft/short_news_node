const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '.env') });

const LiveStream = require('./models/LiveStream');

async function checkLiveStream() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Connected to MongoDB');

        const status = await LiveStream.findOne();
        if (status) {
            console.log('--- Current Live Stream Status ---');
            console.log('isLive:', status.isLive);
            console.log('URL:', status.url);
            console.log('UpdatedAt:', status.updatedAt);
            console.log('-----------------------------------');
        } else {
            console.log('No LiveStream document found in database.');
        }

        await mongoose.connection.close();
    } catch (error) {
        console.error('Error:', error);
    }
}

checkLiveStream();
