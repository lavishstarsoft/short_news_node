const mongoose = require('mongoose');
const Admin = require('./models/Admin');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/shortnews', { useNewUrlParser: true, useUnifiedTopology: true })
  .then(async () => {
    const wasim = await Admin.findOne({ username: /wasi/i }).lean();
    console.log('Wasim:', {
      name: wasim.name,
      permissions: wasim.permissions
    });
    process.exit(0);
  });
