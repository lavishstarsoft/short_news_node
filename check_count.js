const mongoose = require('mongoose');
require('dotenv').config();
const User = require('./models/User');

async function run() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    
    const count = await User.countDocuments({ referralCode: { $exists: true, $ne: null } });
    console.log(`Users with referral code: ${count}`);

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
  }
}

run();
