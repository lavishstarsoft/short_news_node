const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const Admin = require('./models/Admin');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const reporters = await Admin.find({ role: 'editor' }).select('name assignedState assignedDistricts').lean();
  
  const grouped = {};
  for (const r of reporters) {
    const state = r.assignedState || 'Unknown State';
    const district = (r.assignedDistricts && r.assignedDistricts.length > 0) ? r.assignedDistricts[0] : 'Unknown District';
    
    if (!grouped[state]) grouped[state] = {};
    if (!grouped[state][district]) grouped[state][district] = [];
    grouped[state][district].push(r.name || 'Unnamed Reporter');
  }
  
  let markdown = '# Reporters List\n\nThis document contains the list of reporters grouped by state and district.\n\n';
  
  for (const state of Object.keys(grouped).sort()) {
    markdown += `## ${state}\n`;
    for (const district of Object.keys(grouped[state]).sort()) {
      markdown += `### ${district}\n`;
      for (const name of grouped[state][district].sort()) {
        markdown += `- ${name}\n`;
      }
      markdown += '\n';
    }
  }

  const dest = '/Users/saisudhakarmanchala/.gemini/antigravity-ide/brain/9e131cdb-d9dc-4857-b2fa-69029d5ab770/reporters_list.md';
  fs.writeFileSync(dest, markdown, 'utf8');
  console.log('Artifact generated successfully.');
  process.exit(0);
}
run().catch(console.error);
