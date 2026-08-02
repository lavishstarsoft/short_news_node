const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

const News = require('./models/News');
const Admin = require('./models/Admin');
const User = require('./models/User');

async function updateNewsLanguage() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    let authorEmail = 'chandelrandhir000@gmail.com';
    let authorId = null;
    let authorName = null;

    let admin = await Admin.findOne({ email: authorEmail });
    if (admin) {
      authorId = admin._id.toString();
      authorName = admin.username;
      console.log('Found Admin:', authorName, 'with ID:', authorId);
    } else {
      let user = await User.findOne({ email: authorEmail });
      if (user) {
        authorId = user._id.toString();
        authorName = user.displayName;
        console.log('Found User:', authorName, 'with ID:', authorId);
      }
    }

    if (!authorId) {
      console.log('Author not found in Admin or User collections. Trying to update by author name if known...');
      const newsByAuthor = await News.find({ author: authorEmail });
      if (newsByAuthor.length > 0) {
        console.log(`Found ${newsByAuthor.length} news by author field matching email.`);
        const result = await News.updateMany(
          { author: authorEmail },
          { $set: { language: 'hi' } }
        );
        console.log(`Updated ${result.modifiedCount} news documents to hindi.`);
      } else {
        console.log('Could not find authorId or author field matching email.');
      }
    } else {
      const newsCount = await News.countDocuments({ authorId: authorId });
      console.log(`Found ${newsCount} news articles by authorId ${authorId}`);
      
      const result = await News.updateMany(
        { authorId: authorId },
        { $set: { language: 'hi' } }
      );
      console.log(`Updated ${result.modifiedCount} news documents to hindi.`);
    }

  } catch (error) {
    console.error('Error updating news:', error);
  } finally {
    mongoose.connection.close();
  }
}

updateNewsLanguage();
