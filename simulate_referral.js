const mongoose = require('mongoose');
const dotenv = require('dotenv');
const axios = require('axios');
const crypto = require('crypto');
dotenv.config();

async function simulateReferralFlow() {
  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('./models/User');
  const Referral = require('./models/Referral');
  const PendingReferral = require('./models/PendingReferral');

  console.log('--- STARTING QA TEST ---');
  
  let referrer = await User.findOne({ email: 'referrer@test.com' });
  if (!referrer) {
    referrer = new User({
      googleId: 'ref_123',
      email: 'referrer@test.com',
      displayName: 'Referrer User',
      referralCode: 'TESTCODE123'
    });
    await referrer.save();
    console.log('Created referrer user:', referrer.referralCode);
  }

  // CLEAR OLD SIMULATION RUNS
  await PendingReferral.deleteMany({ referralCode: referrer.referralCode });
  await Referral.deleteMany({ referralCode: referrer.referralCode });

  console.log('Simulating invite link click...');
  try {
    const res = await axios.get('http://localhost:3001/invite/' + referrer.referralCode, {
      headers: {
        'x-forwarded-for': '1.2.3.4',
        'user-agent': 'QA Test Agent'
      }
    });
    console.log('Invite Click Status:', res.status);
  } catch (err) {
    console.error('Invite Click Failed:', err.response?.status, err.response?.data);
  }

  const pendings = await PendingReferral.find({ referralCode: referrer.referralCode });
  console.log('PendingReferrals count after click:', pendings.length);

  console.log('Simulating fallback-match...');
  try {
    const fallbackRes = await axios.post('http://localhost:3001/api/public/referral/fallback-match', {
      deviceInfo: 'test_device_fingerprint_xyz'
    }, {
      headers: {
        'x-forwarded-for': '1.2.3.4'
      }
    });
    console.log('Fallback Match Response:', fallbackRes.data);
  } catch (err) {
    console.error('Fallback Match Failed:', err.message);
  }

  console.log('Simulating claim API...');
  const requestBody = JSON.stringify({
    referralCode: referrer.referralCode,
    referredUserId: 'new_user_456',
    deviceFingerprint: 'test_device_fingerprint_xyz',
    integrityToken: 'dummy_token'
  });

  const timestamp = Date.now().toString();
  const SECRET_KEY = 'super_secret_referral_key_2026';
  const signaturePayload = timestamp + requestBody;
  const signature = crypto
    .createHmac('sha256', SECRET_KEY)
    .update(signaturePayload)
    .digest('hex');

  try {
    const claimRes = await axios.post('http://localhost:3001/api/public/referral/claim', requestBody, {
      headers: {
        'x-forwarded-for': '1.2.3.4',
        'Content-Type': 'application/json',
        'x-timestamp': timestamp,
        'x-signature': signature
      }
    });
    console.log('Claim Response:', claimRes.data);
  } catch (err) {
    console.error('Claim Failed:', err.response?.status, err.response?.data);
  }

  const referrals = await Referral.find({ referralCode: referrer.referralCode });
  console.log('Actual Referrals created in DB:', referrals.length);
  if (referrals.length > 0) {
    console.log('Referral status:', referrals[0].status);
    console.log('Referral user ID:', referrals[0].referrerUserId);
  }

  process.exit(0);
}
simulateReferralFlow();
