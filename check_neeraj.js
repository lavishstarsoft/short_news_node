const mongoose = require('mongoose');
const ReporterApplication = require('./models/ReporterApplication');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/shortnews').then(async () => {
    const apps = await ReporterApplication.find({ 'data.Name': /Neeraj/i });
    console.log(`Found ${apps.length} applications for Neeraj`);
    apps.forEach(app => console.log(JSON.stringify(app.data, null, 2)));
    process.exit();
});
