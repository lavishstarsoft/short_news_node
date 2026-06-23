const mongoose = require('mongoose');
require('dotenv').config();
const News = require('./models/News');
const Admin = require('./models/Admin');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    const page = 629;
    const limit = 21;
    const skip = (page - 1) * limit;
    const query = {};
    const newsList = await News.find(query).sort({ publishedAt: -1 }).skip(skip).limit(limit);
    const authorIds = [...new Set(newsList.map(news => news.authorId).filter(Boolean))];
    console.log('authorIds:', authorIds);
    const authors = await Admin.find({ _id: { $in: authorIds } }).select('_id role displayRole').lean();
    console.log('authors found:', authors.length);
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    mongoose.disconnect();
  }
}
run();
