require('dotenv').config();
const mongoose = require('mongoose');
const Admin = require('./models/Admin');

async function test() {
  await mongoose.connect(process.env.MONGODB_URI);
  const admins = await Admin.find({ $or: [ { assignedStates: { $not: {$size: 0} } }, { assignedDistricts: { $not: {$size: 0} } } ] }).select('role assignedStates assignedDistricts').lean();
  console.log(JSON.stringify(admins.slice(0, 5), null, 2));
  process.exit(0);
}
test();
