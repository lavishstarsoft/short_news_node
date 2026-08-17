const mongoose = require('mongoose');
const dotenv = require('dotenv');
const { registerEditor } = require('./controllers/adminController');
const Admin = require('./models/Admin');
const Location = require('./models/Location');
const StaffCategory = require('./models/StaffCategory');

dotenv.config();

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/shortnews_dev_local';

async function runTests() {
  await mongoose.connect(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log('Connected to DB');

  // Seed Locations
  await Location.deleteMany({ name: { $in: ['TestStateA', 'TestStateB', 'TestDistA1', 'TestDistA2', 'TestDistB1'] } });
  
  await Location.create([
    { name: 'TestStateA', locationType: 'state', code: 'TSA' },
    { name: 'TestStateB', locationType: 'state', code: 'TSB' },
    { name: 'TestDistA1', locationType: 'district', parentName: 'TestStateA', code: 'TDA1' },
    { name: 'TestDistA2', locationType: 'district', parentName: 'TestStateA', code: 'TDA2' },
    { name: 'TestDistB1', locationType: 'district', parentName: 'TestStateB', code: 'TDB1' }
  ]);
  
  // Remove test users
  // await Admin.deleteMany({ username: { $regex: /^testuser_/ } });

  // Create a mock superadmin req user
  const superadmin = await Admin.findOne({ role: 'superadmin' }) || { _id: new mongoose.Types.ObjectId() };
  
  const createReq = (body) => ({
    admin: { id: superadmin._id },
    body: {
      password: 'password123',
      role: 'editor',
      displayRole: 'Reporter',
      ...body
    }
  });

  const createRes = () => {
    const res = {
      statusCode: 200,
      jsonData: null,
      status: function(code) { this.statusCode = code; return this; },
      json: function(data) { this.jsonData = data; return this; }
    };
    return res;
  };

  let req, res;
  let passed = 0, failed = 0;

  const assertEqual = (expected, actual, msg) => {
    if (expected === actual) {
      console.log(`✅ PASS: ${msg}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${msg}. Expected ${expected}, got ${actual}`);
      failed++;
    }
  };

  const assertIncludes = (actual, substring, msg) => {
    if (actual && actual.includes(substring)) {
      console.log(`✅ PASS: ${msg}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${msg}. Expected string containing '${substring}', got '${actual}'`);
      failed++;
    }
  };

  console.log('--- Running Tests ---');

  // Test 1: Valid State + District
  req = createReq({
    username: 'testuser_valid',
    email: 'testuser_valid@test.com',
    assignedStates: ['TestStateA'],
    assignedDistricts: ['TestDistA1']
  });
  res = createRes();
  await registerEditor(req, res);
  assertEqual(201, res.statusCode, 'Valid State + District should be accepted (201)');
  
  const savedValid = await Admin.findOne({ username: 'testuser_valid' });
  assertEqual('TestStateA', savedValid.assignedStates[0], 'Assigned state preserved');
  assertEqual('TestDistA1', savedValid.assignedDistricts[0], 'Assigned district preserved');

  // Test 2: Cross-state district rejected
  req = createReq({
    username: 'testuser_cross',
    email: 'testuser_cross@test.com',
    assignedStates: ['TestStateA'],
    assignedDistricts: ['TestDistB1']
  });
  res = createRes();
  await registerEditor(req, res);
  assertEqual(400, res.statusCode, 'Cross-state district should be rejected (400)');
  assertIncludes(res.jsonData?.error || '', 'Invalid districts for selected states', 'Error message for cross-state district');

  // Test 3: Invalid/nonexistent State rejected
  req = createReq({
    username: 'testuser_invalid_state',
    email: 'testuser_invalid_state@test.com',
    assignedStates: ['NonExistentState']
  });
  res = createRes();
  await registerEditor(req, res);
  assertEqual(400, res.statusCode, 'Nonexistent state should be rejected (400)');
  assertIncludes(res.jsonData?.error || '', 'Invalid states selected', 'Error message for invalid state');

  // Test 4: Invalid/nonexistent District rejected
  req = createReq({
    username: 'testuser_invalid_dist',
    email: 'testuser_invalid_dist@test.com',
    assignedStates: ['TestStateA'],
    assignedDistricts: ['NonExistentDist']
  });
  res = createRes();
  await registerEditor(req, res);
  assertEqual(400, res.statusCode, 'Nonexistent district should be rejected (400)');
  assertIncludes(res.jsonData?.error || '', 'Invalid districts', 'Error message for invalid district');

  // Test 5: District without State rejected
  req = createReq({
    username: 'testuser_no_state',
    email: 'testuser_no_state@test.com',
    assignedDistricts: ['TestDistA1']
  });
  res = createRes();
  await registerEditor(req, res);
  assertEqual(400, res.statusCode, 'District without State should be rejected (400)');
  assertIncludes(res.jsonData?.error || '', 'Cannot assign districts without assigning states', 'Error message for district without state');

  // Test 6: Duplicate username remains intact
  req = createReq({
    username: 'testuser_valid',
    email: 'testuser_dup2@test.com',
    assignedStates: ['TestStateA']
  });
  res = createRes();
  await registerEditor(req, res);
  assertEqual(400, res.statusCode, 'Duplicate username should be rejected (400)');
  assertIncludes(res.jsonData?.error || '', 'Username or email already exists', 'Error message for duplicate username');

  // Cleanup
  await Location.deleteMany({ name: { $in: ['TestStateA', 'TestStateB', 'TestDistA1', 'TestDistA2', 'TestDistB1'] } });
  // await Admin.deleteMany({ username: { $regex: /^testuser_/ } });
  
  console.log(`\nTests finished: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
