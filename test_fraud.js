const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const FraudBlocklist = require('./models/FraudBlocklist');
  const Admin = require('./models/Admin');
  
  const admin = await Admin.findOne();

  // Create a block
  const testBlock = new FraudBlocklist({
    identifier: 'test_ip_123',
    type: 'ip',
    reason: 'Test block',
    blockedBy: admin._id
  });
  
  await testBlock.save();
  console.log('Blocked successfully');
  
  const found = await FraudBlocklist.findOne({ identifier: 'test_ip_123' });
  console.log('Found:', found.type);
  
  await FraudBlocklist.deleteOne({ identifier: 'test_ip_123' });
  console.log('Cleaned up');
  
  process.exit(0);
}
run();
