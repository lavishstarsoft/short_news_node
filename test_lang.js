const mongoose = require('mongoose');
const Language = require('./models/Language');
require('dotenv').config({ path: './.env' });

mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(async () => {
    const langs = await Language.getActiveLanguages();
    console.log("Languages:", langs.map(l => ({ name: l.name, code: l.code })));
    mongoose.disconnect();
  })
  .catch(err => console.error(err));
