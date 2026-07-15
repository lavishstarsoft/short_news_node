const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('./models/User');
  const tenMinsAgo = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
  const recentLogins = await User.find({ lastLogin: { $gt: tenMinsAgo } }).sort({ lastLogin: -1 });
  console.log(`=== LOGGED IN LAST 1 HOUR (${recentLogins.length}) ===`);
  recentLogins.forEach(u => {
    console.log(`- Email: ${u.email} | GoogleId: ${u.googleId} | ReferralCode: ${u.referralCode} | ID: ${u._id}`);
  });
  process.exit(0);
}
run();
