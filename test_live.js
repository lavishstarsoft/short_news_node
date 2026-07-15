const axios = require('axios');
async function run() {
  try {
    const res = await axios.post('https://www.news.tehelkanews.in/api/public/referral/fallback-match', { deviceInfo: 'test' });
    console.log('Response:', res.status, res.data);
  } catch (err) {
    console.log('Error:', err.response?.status, err.response?.data || err.message);
  }
}
run();
