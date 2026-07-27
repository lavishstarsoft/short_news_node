require('dotenv').config();
const mongoose = require('mongoose');
const News = require('./models/News');

const mongoUri = process.env.MONGODB_URI;

async function testUpdate() {
  await mongoose.connect(mongoUri);
  const existingNews = await News.findOne();
  if (!existingNews) {
    console.log("No news found");
    process.exit(0);
  }
  console.log("Found news:", existingNews._id);
  
  try {
    const id = existingNews._id;
    const views = 100;
    
    const news = await News.findByIdAndUpdate(
        id,
        {
          views: views
        },
        { new: true }
    );
    console.log("Success update views!");
  } catch (err) {
    console.error("Error during update:", err);
  }
  process.exit(0);
}
testUpdate();
