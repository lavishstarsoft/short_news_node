const mongoose = require('mongoose');
const Language = require('./models/Language');
require('dotenv').config();

const ranges = {
  'Telugu': '\\u0C00-\\u0C7F',
  'English': 'A-Za-z',
  'Hindi': '\\u0900-\\u097F',
  'Tamil': '\\u0B80-\\u0BFF',
  'Marathi': '\\u0900-\\u097F',
  'Kannada': '\\u0C80-\\u0CFF',
  'Malayalam': '\\u0D00-\\u0D7F',
  'Gujarati': '\\u0A80-\\u0AFF',
  'Bengali': '\\u0980-\\u09FF'
};

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/shortnews')
  .then(async () => {
    const languages = await Language.find({});
    for (let lang of languages) {
      if (ranges[lang.name]) {
        lang.unicodeRange = ranges[lang.name];
        await lang.save();
        console.log(`Updated ${lang.name} with range ${lang.unicodeRange}`);
      }
    }
    console.log('Update complete.');
    process.exit(0);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
