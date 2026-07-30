const mongoose = require('mongoose');
const ReporterApplication = require('./models/ReporterApplication');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/shortnews').then(async () => {
    const apps = await ReporterApplication.find().sort({ createdAt: -1 }).limit(5).lean();
    apps.forEach(app => {
        console.log('App:', app._id, app.createdAt);
        console.log(JSON.stringify(app.data, null, 2));
        console.log('---');
    });
    process.exit();
});
