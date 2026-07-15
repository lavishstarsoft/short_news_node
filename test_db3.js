const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const PendingReferral = require('./models/PendingReferral');
  const pends = await PendingReferral.find();
  console.log(pends);
  
  process.exit(0);
}
check();
