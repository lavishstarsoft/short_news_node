const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '.env') });

const News = require('./models/News');

async function printLatestNews() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        const newsList = await News.find().sort({ publishedAt: -1 }).limit(5);
        
        console.log('--- Latest 5 News Articles ---');
        newsList.forEach((news, i) => {
            console.log(`${i+1}. Title: ${news.title}`);
            console.log(`   Media URL: ${news.mediaUrl}`);
            console.log(`   Media Type: ${news.mediaType}`);
            console.log(`   Is Active: ${news.isActive}`);
            console.log('---------------------------');
        });
        
        await mongoose.connection.close();
    } catch (error) {
        console.error('Error:', error);
    }
}

printLatestNews();
