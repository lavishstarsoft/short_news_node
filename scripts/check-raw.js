const mongoose = require('mongoose');
require('dotenv').config();

async function runCheck() {
    try {
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/shortnews');
        console.log('Connected to DB');

        const db = mongoose.connection.db;
        const appSettingsCollection = db.collection('appsettings');
        
        const doc = await appSettingsCollection.findOne({ key: 'update_flags' });
        if (doc) {
            console.log('Document keys:', Object.keys(doc));
            console.log('isQuizEnabled exists:', 'isQuizEnabled' in doc);
            console.log('quizEnabledLanguages exists:', 'quizEnabledLanguages' in doc);
        } else {
            console.log('Document not found');
        }

        await mongoose.connection.close();
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}
runCheck();
