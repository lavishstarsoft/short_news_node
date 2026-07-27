require('dotenv').config();
const mongoose = require('mongoose');
const Location = require('./models/Location');

const mongoUri = process.env.MONGODB_URI;

async function testLocations() {
  await mongoose.connect(mongoUri);
  try {
    const hierarchy = await Location.getHierarchy();
    console.log("Hierarchy length:", hierarchy.length);
  } catch (err) {
    console.error("Error reading hierarchy:", err);
  }
  process.exit(0);
}
testLocations();
