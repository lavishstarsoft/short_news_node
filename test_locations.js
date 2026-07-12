const mongoose = require('mongoose');
require('dotenv').config();
const Location = require('./models/Location');

async function test() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/shortnews');
  const up = await Location.findOne({ type: 'state', name: 'Uttar Pradesh' }).lean();
  console.log(up);
  mongoose.disconnect();
}
test();
