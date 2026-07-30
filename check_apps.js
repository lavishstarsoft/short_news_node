require('dotenv').config();
const mongoose = require('mongoose');

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/shortnews').then(async () => {
    const ReporterApplication = mongoose.model('ReporterApplication', new mongoose.Schema({}, { strict: false }));
    const apps = await ReporterApplication.find().sort({ createdAt: -1 }).limit(5).lean();
    console.log(JSON.stringify(apps.map(a => a.data), null, 2));
    process.exit(0);
});
