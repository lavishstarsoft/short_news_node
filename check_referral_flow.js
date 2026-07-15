const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  
  const PendingReferral = require('./models/PendingReferral');
  const Referral = require('./models/Referral');
  const User = require('./models/User');

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  console.log("=== RECENT USERS ===");
  const recentUsers = await User.find({ createdAt: { $gt: oneHourAgo } }).sort({ createdAt: -1 });
  recentUsers.forEach(u => console.log(`- ${u.displayName} (${u.email}) | ID: ${u._id} | RefCode: ${u.referralCode} | Created: ${u.createdAt}`));

  console.log("\n=== PENDING REFERRALS (Last 2 hours) ===");
  const pending = await PendingReferral.find({}).sort({ createdAt: -1 }).limit(10);
  pending.forEach(p => console.log(`- Code: ${p.referralCode} | IP: ${p.ipAddress} | Created: ${p.createdAt}`));

  console.log("\n=== RECENT REFERRALS (Claimed) ===");
  const claims = await Referral.find({}).sort({ createdAt: -1 }).limit(5);
  claims.forEach(c => console.log(`- Referrer: ${c.referrerUserId} | Referred: ${c.referredUserId} | Status: ${c.status} | Created: ${c.createdAt}`));

  process.exit(0);
}
run();
