const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();
async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const Referral = require('./models/Referral');
  const refs = await Referral.find();
  console.log(refs.map(r => r.referredUserId));
  process.exit(0);
}
check();
