const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

const mongoUri = process.env.MONGODB_URI || 'mongodb+srv://ashokca810:ashokca810@cluster0.psirpqa.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';

async function clearApplications() {
    try {
        await mongoose.connect(mongoUri);
        console.log('Connected to MongoDB');
        
        const ReporterApplication = require('./models/ReporterApplication');
        const result = await ReporterApplication.deleteMany({});
        
        console.log(`Successfully deleted ${result.deletedCount} reporter applications.`);
        process.exit(0);
    } catch (error) {
        console.error('Error clearing applications:', error);
        process.exit(1);
    }
}

clearApplications();
