const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('./models/User');
  const AppSettings = require('./models/AppSettings');
  
  const latestUsers = await User.find().sort({ createdAt: -1 }).limit(1);
  if (latestUsers.length === 0) return console.log("No users");
  
  const user = latestUsers[0];
  console.log("Testing my-stats logic for latest user:");
  console.log(`- ID: ${user._id}`);
  console.log(`- GoogleId: ${user.googleId}`);
  
  // What my-stats does:
  const foundUser = await User.findOne({ googleId: user.googleId }).select(
      'referralCode walletBalance totalEarned totalReferrals'
  );
  console.log("- Found User by googleId:", foundUser ? "YES" : "NO");
  
  const appSettings = await AppSettings.findOne({ key: 'update_flags' });
  console.log("- AppSettings found:", appSettings ? "YES" : "NO");
  
  process.exit(0);
}
run();
