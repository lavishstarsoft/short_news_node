require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const ads = await db.collection('ads').find({}).toArray();
  console.log(`Total ads in DB: ${ads.length}`);
  ads.forEach(ad => {
    console.log(`\n--- ${ad.title} ---`);
    console.log(`  _id: ${ad._id}`);
    console.log(`  isActive: ${ad.isActive}`);
    console.log(`  language field exists: ${'language' in ad}`);
    console.log(`  language value: ${JSON.stringify(ad.language)}`);
    console.log(`  language type: ${typeof ad.language}`);
  });
  await mongoose.disconnect();
}

main().catch(console.error);
