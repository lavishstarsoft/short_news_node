const mongoose = require('mongoose');
require('dotenv').config();
const User = require('./models/User');

async function run() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('Connected to MongoDB.');

    const users = await User.find({}).select('email googleId mobileNumber referralCode');
    console.log(`Found ${users.length} users`);
    
    users.forEach(u => {
      console.log(`User: ${u.email || u.mobileNumber || u.googleId} | Referral: ${u.referralCode}`);
    });

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected.');
  }
}

run();
