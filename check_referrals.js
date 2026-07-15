const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const Referral = require('./models/Referral');
  const PendingReferral = require('./models/PendingReferral');
  
  const refCount = await Referral.countDocuments();
  const pendCount = await PendingReferral.countDocuments();
  console.log('Referrals count:', refCount);
  console.log('PendingReferrals count:', pendCount);
  
  process.exit(0);
}
run();
