const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('./models/User');
  const Referral = require('./models/Referral');
  const PendingReferral = require('./models/PendingReferral');
  
  const user = await User.findOne({ email: 'amararapumonika@gmail.com' });
  console.log('User:', user ? 'Exists' : 'Null');
  
  const refs = await Referral.find();
  console.log('Total Referrals:', refs.length);
  console.log('Referrals:', refs.map(r => r.referredEmail || r.referredUserId));
  
  const pends = await PendingReferral.find();
  console.log('Total PendingReferrals:', pends.length);
  
  process.exit(0);
}
check();
