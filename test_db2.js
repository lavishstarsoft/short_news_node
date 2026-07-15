const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('./models/User');
  const user = await User.findOne({ email: 'amararapumonika@gmail.com' });
  console.log(user);
  
  process.exit(0);
}
check();
