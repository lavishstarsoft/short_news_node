const mongoose = require('mongoose');
require('dotenv').config();
const AppSettings = require('../models/AppSettings');
const QuizSettings = require('../models/QuizSettings');

async function runPreflight() {
    try {
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/shortnews');
        console.log('Connected to DB');

        // Check QuizSettings
        const qs = await QuizSettings.findOne({ key: 'quiz_config' });
        if (!qs) {
            console.error('QuizSettings document not found!');
            process.exit(1);
        }
        console.log('QuizSettings found. isEnabled:', qs.isEnabled, 'enabledLanguages:', qs.enabledLanguages);

        // Check AppSettings
        const totalAppSettings = await AppSettings.countDocuments();
        const appSettingsWithLegacyFields = await AppSettings.countDocuments({
            $or: [
                { isQuizEnabled: { $exists: true } },
                { quizEnabledLanguages: { $exists: true } }
            ]
        });

        console.log('Total AppSettings documents:', totalAppSettings);
        console.log('AppSettings with legacy Quiz fields:', appSettingsWithLegacyFields);

        await mongoose.connection.close();
    } catch (e) {
        console.error('Preflight error:', e);
        process.exit(1);
    }
}

runPreflight();
