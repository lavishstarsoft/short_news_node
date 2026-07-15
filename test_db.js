const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to MongoDB");
  const User = require('./models/User');
  const Referral = require('./models/Referral');
  
  const recentUsers = await User.find().sort({ createdAt: -1 }).limit(5);
  console.log("Recent Users:");
  recentUsers.forEach(u => console.log(`- ${u.name} (ID: ${u._id}) | referredBy: ${u.referredBy || 'None'} | createdAt: ${u.createdAt}`));
  
  const recentReferrals = await Referral.find().sort({ createdAt: -1 }).limit(5);
  console.log("\nRecent Referrals:");
  recentReferrals.forEach(r => console.log(`- Referrer: ${r.referrerId} | Referred: ${r.referredUserId} | Status: ${r.status} | createdAt: ${r.createdAt}`));
  
  process.exit(0);
}
run();
