const mongoose = require('mongoose');
require('dotenv').config();
const User = require('./models/User');
const crypto = require('crypto');

async function run() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('Connected to MongoDB.');

    // Find all users missing referralCode OR referralCode is empty/null
    const users = await User.find({
      $or: [
        { referralCode: { $exists: false } },
        { referralCode: null },
        { referralCode: '' }
      ]
    }).lean(); // lean() returns plain JS objects, no mongoose magic
    
    console.log(`Found ${users.length} users missing referralCode.`);
    let updated = 0;
    
    const bulkOps = [];
    
    for (const user of users) {
      if (!user.referralCode) {
        const newCode = crypto.randomBytes(4).toString('hex').toUpperCase();
        bulkOps.push({
          updateOne: {
            filter: { _id: user._id },
            update: { $set: { referralCode: newCode } }
          }
        });
        updated++;
      }
    }

    if (bulkOps.length > 0) {
      const result = await User.collection.bulkWrite(bulkOps);
      console.log(`Successfully generated referral codes for ${result.modifiedCount} existing users.`);
    } else {
      console.log('No users to update.');
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected.');
  }
}

run();
