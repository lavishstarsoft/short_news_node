require('dotenv').config();
const mongoose = require('mongoose');
const Location = require('./models/Location');

async function test() {
  await mongoose.connect(process.env.MONGODB_URI);
  const hierarchy = await Location.getHierarchy();
  console.log(JSON.stringify(hierarchy[0], null, 2));
  process.exit(0);
}
test();
