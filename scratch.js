const mongoose = require('mongoose');
require('dotenv').config();
const Admin = require('./models/Admin');

mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(async () => {
    const admin = await Admin.findOne({ name: /Arun/i });
    console.log(admin);
    mongoose.disconnect();
  });
