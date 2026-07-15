const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('./models/User');
  const latestUsers = await User.find().sort({ createdAt: -1 }).limit(3);
  console.log("=== LATEST USERS ===");
  latestUsers.forEach(u => {
    console.log(`- Email: ${u.email} | GoogleId: ${u.googleId} | ReferralCode: ${u.referralCode || 'MISSING'}`);
  });
  process.exit(0);
}
run();
