const mongoose = require('mongoose');
require('dotenv').config();
const Admin = require('./models/Admin');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const reporters = await Admin.find({ role: 'editor' }).select('name assignedState assignedDistricts').lean();
  
  const grouped = {};
  for (const r of reporters) {
    const state = r.assignedState || 'Unknown State';
    // Some reporters might have multiple districts, let's take the first one or "Unknown District"
    const district = (r.assignedDistricts && r.assignedDistricts.length > 0) ? r.assignedDistricts[0] : 'Unknown District';
    
    if (!grouped[state]) grouped[state] = {};
    if (!grouped[state][district]) grouped[state][district] = [];
    grouped[state][district].push(r.name || 'Unnamed Reporter');
  }
  
  console.log(JSON.stringify(grouped, null, 2));
  process.exit(0);
}
run().catch(console.error);
