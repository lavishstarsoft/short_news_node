const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('./models/User');
  try {
    const user = new User({
      displayName: 'Test User',
      googleId: 'test_google_id_123',
      email: 'test1234@gmail.com',
      lastLogin: new Date(),
    });
    await user.save();
    console.log("Saved successfully:", user._id);
    await User.findByIdAndDelete(user._id);
  } catch (err) {
    console.log("MONGOOSE ERROR:", err);
  }
  process.exit(0);
}
run();
