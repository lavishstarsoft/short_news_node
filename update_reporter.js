require('dotenv').config();
const mongoose = require('mongoose');
const Admin = require('./models/Admin');

async function updateUsername() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to DB');

    const emailToFind = 'santhoshchav@gmail.com';
    const admin = await Admin.findOne({ email: emailToFind });

    if (admin) {
      console.log(`Found reporter: ${admin.email}, Current username: ${admin.username}`);
      admin.username = 'santhoshchav@gmail.com';
      await admin.save();
      console.log(`Successfully updated username to: ${admin.username}`);
    } else {
      console.log(`Reporter with email ${emailToFind} not found.`);
    }

  } catch (err) {
    console.error('Error updating reporter:', err);
  } finally {
    process.exit(0);
  }
}

updateUsername();
