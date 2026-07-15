const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('./models/User');
  const tenMinsAgo = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48 hours ago
  const recentUsers = await User.find({ createdAt: { $gt: tenMinsAgo } }).sort({ createdAt: -1 }).limit(10);
  console.log(`=== USERS CREATED IN LAST 48 HOURS (${recentUsers.length}) ===`);
  recentUsers.forEach(u => {
    console.log(`- Created: ${u.createdAt} | Email: ${u.email} | GoogleId: ${u.googleId} | ReferralCode: ${u.referralCode || 'MISSING'}`);
  });
  process.exit(0);
}
run();
