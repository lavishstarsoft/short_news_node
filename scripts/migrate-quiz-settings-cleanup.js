const mongoose = require('mongoose');
require('dotenv').config();
const AppSettings = require('../models/AppSettings');

async function migrate() {
    try {
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/shortnews');
        console.log('Connected to DB');

        const args = process.argv.slice(2);
        const isApply = args.includes('--apply');

        const filter = {
            $or: [
                { isQuizEnabled: { $exists: true } },
                { quizEnabledLanguages: { $exists: true } }
            ]
        };

        const count = await AppSettings.countDocuments(filter);

        if (!isApply) {
            console.log(`[DRY RUN] Found ${count} AppSettings document(s) with legacy Quiz fields.`);
            console.log(`[DRY RUN] The following fields will be $unset: isQuizEnabled, quizEnabledLanguages`);
            console.log(`[DRY RUN] Run with --apply to execute the migration.`);
        } else {
            console.log(`[MIGRATION] Found ${count} AppSettings document(s) with legacy Quiz fields.`);
            const result = await AppSettings.updateMany(filter, {
                $unset: {
                    isQuizEnabled: 1,
                    quizEnabledLanguages: 1
                }
            }, { strict: false });
            console.log(`[MIGRATION] Success! Modified ${result.modifiedCount} document(s).`);
        }

        await mongoose.connection.close();
    } catch (e) {
        console.error('Migration error:', e);
        process.exit(1);
    }
}

migrate();
