require('dotenv').config();
const mongoose = require('mongoose');
const Admin = require('./models/Admin');

// MongoDB connection string
const mongoUri = process.env.MONGODB_URI || 'mongodb+srv://ashokca810:ashokca810@cluster0.psirpqa.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';

// Admin credentials to create
const adminCredentials = {
  username: 'admin',
  email: 'admin@lavishstar.in',
  password: 'admin123', // This will be hashed automatically by the model
  role: 'superadmin', // Options: 'admin', 'superadmin', 'editor'
  isActive: true
};

async function createAdmin() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('✅ Connected to MongoDB successfully');

    // Check if admin already exists
    const existingAdmin = await Admin.findOne({ 
      $or: [
        { username: adminCredentials.username },
        { email: adminCredentials.email }
      ]
    });

    if (existingAdmin) {
      console.log('⚠️  Admin already exists with this username or email:');
      console.log(`   Username: ${existingAdmin.username}`);
      console.log(`   Email: ${existingAdmin.email}`);
      console.log(`   Role: ${existingAdmin.role}`);
      console.log('\nTo create a new admin, please use different username or email.');
      process.exit(0);
    }

    // Create new admin
    console.log('\nCreating admin user...');
    const newAdmin = new Admin({
      username: adminCredentials.username,
      email: adminCredentials.email,
      password: adminCredentials.password, // Will be hashed by pre-save hook
      role: adminCredentials.role,
      isActive: adminCredentials.isActive
    });

    await newAdmin.save();
    
    console.log('\n✅ Admin created successfully!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Admin Credentials:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Username: ${adminCredentials.username}`);
    console.log(`Email:    ${adminCredentials.email}`);
    console.log(`Password: ${adminCredentials.password}`);
    console.log(`Role:     ${adminCredentials.role}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('\n⚠️  Please save these credentials securely!');
    console.log('You can now login at: http://localhost:3001/login');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating admin:', error.message);
    if (error.code === 11000) {
      console.error('   Duplicate key error: Admin with this username or email already exists');
    }
    process.exit(1);
  }
}

// Run the script
createAdmin();

