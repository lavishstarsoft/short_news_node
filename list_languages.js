const mongoose = require('mongoose');
const Language = require('./models/Language');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/shortnews')
  .then(async () => {
    const languages = await Language.find({}, 'name unicodeRange');
    console.log(languages);
    process.exit(0);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
