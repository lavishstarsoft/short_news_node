const mongoose = require('mongoose');
const ReporterApplication = require('./models/ReporterApplication');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/shortnews').then(async () => {
    const apps = await ReporterApplication.find({ 'data.Name': /Neeraj/i }).lean();
    apps.forEach(app => {
        console.log('Location:', app.data.Location, 'Type:', typeof app.data.Location, 'IsArray:', Array.isArray(app.data.Location));
        console.log('Name:', app.data.Name, 'Type:', typeof app.data.Name);
        console.log('Email:', app.data.email, 'Type:', typeof app.data.email);
        console.log('Phone:', app.data.phone_number, 'Type:', typeof app.data.phone_number);
    });
    process.exit();
});
