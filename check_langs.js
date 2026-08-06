const mongoose = require('mongoose');
require('dotenv').config();
const Language = require('./models/Language');
mongoose.connect(process.env.MONGODB_URI).then(async () => {
    const langs = await Language.find().lean();
    console.log(langs.map(l => ({ name: l.name, code: l.code })));
    mongoose.disconnect();
});
