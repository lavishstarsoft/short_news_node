const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

async function cleanUser() {
  const email = 'amararapumonika@gmail.com';
  
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to DB...');

    const User = require('./models/User');
    const Referral = require('./models/Referral');
    
    // Find user
    const user = await User.findOne({ email });
    let googleId = null;
    
    if (user) {
      googleId = user.googleId;
      console.log(`Found user ${email} with googleId ${googleId}. Deleting...`);
      await User.deleteOne({ email });
      console.log('User deleted.');
    } else {
      console.log(`User ${email} not found in User collection.`);
    }

    // Delete referrals where they are the referred user
    const refDelResult = await Referral.deleteMany({ referredEmail: email });
    console.log(`Deleted ${refDelResult.deletedCount} referrals where they were referred.`);

    // If they had a googleId, also delete referrals where they were referredUserId
    if (googleId) {
      const refIdDelResult = await Referral.deleteMany({ referredUserId: googleId });
      console.log(`Deleted ${refIdDelResult.deletedCount} referrals by referredUserId.`);
      
      const referrerDelResult = await Referral.deleteMany({ referrerUserId: googleId });
      console.log(`Deleted ${referrerDelResult.deletedCount} referrals where they were the referrer.`);
    }

    // Delete referrals where they are the referrer
    const refEmailDelResult = await Referral.deleteMany({ referrerEmail: email });
    console.log(`Deleted ${refEmailDelResult.deletedCount} referrals where they were the referrer (by email).`);

    console.log('✅ Cleanup complete for ' + email);
  } catch (error) {
    console.error('Error during cleanup:', error);
  } finally {
    process.exit(0);
  }
}

cleanUser();
