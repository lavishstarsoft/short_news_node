const axios = require('axios');

async function run() {
  try {
    const res = await axios.post('https://www.news.cbnyellowsingam.in/api/public/user/profile', {
      userId: 'test_google_id_123',
      userName: 'Test User 123',
      userEmail: 'test1234@gmail.com',
      deviceFingerprint: 'test_fingerprint'
    });
    console.log("Success:", res.data);
  } catch (err) {
    console.log("Error:", err.response ? err.response.data : err.message);
  }
}
run();
