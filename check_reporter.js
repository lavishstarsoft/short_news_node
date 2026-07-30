require('dotenv').config();
const mongoose = require('mongoose');

async function test() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    
    // Find the news items
    const newsList = await mongoose.connection.db.collection('news').find({
      title: { $regex: 'గురుపూర్ణిమ', $options: 'i' }
    }).toArray();
    
    for (const news of newsList) {
        console.log('---');
        console.log('News Found:', news.title);
        console.log('News Author Constituency:', news.authorConstituency);
        console.log('News Author Name:', news.authorName || news.author);
        console.log('News Author ID:', news.authorId);
        
        if (news.authorId) {
            const author = await mongoose.connection.db.collection('admins').findOne({
                _id: new mongoose.Types.ObjectId(news.authorId)
            });
            if (author) {
                console.log('Admin Collection Constituency:', author.constituency);
            } else {
                console.log('Author not found in admins collection');
            }
        }
    }
    
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}
test();
