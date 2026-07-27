require('dotenv').config();
const mongoose = require('mongoose');
const Admin = require('./models/Admin');

const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
  console.error('MONGODB_URI not set. Aborting.');
  process.exit(1);
}

async function updateSubeditors() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('✅ Connected to MongoDB successfully');

    // Update all sub-editors
    const result = await Admin.updateMany(
      { role: 'subeditor' },
      { $set: { 'permissions.aiCheckEnabled': false } }
    );

    console.log(`✅ Updated ${result.modifiedCount} sub-editors (Matched: ${result.matchedCount}).`);
    process.exit(0);
  } catch (error) {
    console.error('❌ Error updating sub-editors:', error);
    process.exit(1);
  }
}

updateSubeditors();
