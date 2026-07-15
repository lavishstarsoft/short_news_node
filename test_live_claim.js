const axios = require('axios');
const crypto = require('crypto');
async function run() {
  const requestBody = JSON.stringify({
    referralCode: 'E54F5FD8',
    referredUserId: 'amararapumonika@gmail.com',
    deviceFingerprint: '444505940',
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
    const res = await axios.post('https://www.news.tehelkanews.in/api/public/referral/claim', requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'x-timestamp': timestamp,
        'x-signature': signature
      }
    });
    console.log('Response:', res.status, res.data);
  } catch (err) {
    console.log('Error:', err.response?.status, err.response?.data || err.message);
  }
}
run();
