const fs = require('fs');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('./models/User');
  const user = await User.findOne({ email: 'amararapumonika@gmail.com' });
  console.log("User Device Fingerprint:", user.deviceFingerprint);

  process.exit(0);
}
run();
