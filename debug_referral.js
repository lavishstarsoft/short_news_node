const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to MongoDB");
  
  // 1. Check PendingReferrals
  const PendingReferral = require('./models/PendingReferral');
  const pendingAll = await PendingReferral.find().sort({ createdAt: -1 }).limit(10);
  console.log("\n=== PENDING REFERRALS (Fingerprints saved) ===");
  if (pendingAll.length === 0) console.log("NONE FOUND");
  pendingAll.forEach(p => console.log(`- Code: ${p.referralCode} | IP: ${p.ipAddress} | Created: ${p.createdAt}`));
  
  // 2. Check Referral collection
  const Referral = require('./models/Referral');
  const referrals = await Referral.find().sort({ createdAt: -1 }).limit(10);
  console.log("\n=== REFERRALS (Claimed) ===");
  if (referrals.length === 0) console.log("NONE FOUND");
  referrals.forEach(r => console.log(`- Code: ${r.referralCode} | Referrer: ${r.referrerUserId} | Referred: ${r.referredUserId} | Status: ${r.status} | Created: ${r.createdAt}`));
  
  // 3. Check if E54F5FD8 user exists
  const User = require('./models/User');
  const referrer = await User.findOne({ referralCode: 'E54F5FD8' });
  console.log("\n=== REFERRER USER (E54F5FD8) ===");
  if (referrer) {
    console.log(`- Name: ${referrer.name || referrer.displayName} | Email: ${referrer.email} | GoogleId: ${referrer.googleId}`);
  } else {
    console.log("USER NOT FOUND with code E54F5FD8!");
  }
  
  // 4. Check recent users to see if test user registered
  const recentUsers = await User.find().sort({ createdAt: -1 }).limit(5);
  console.log("\n=== RECENT USERS ===");
  recentUsers.forEach(u => console.log(`- Name: ${u.name || u.displayName || 'N/A'} | Email: ${u.email || 'N/A'} | ReferredBy: ${u.referredBy || 'None'} | Created: ${u.createdAt}`));
  
  process.exit(0);
}
run();
