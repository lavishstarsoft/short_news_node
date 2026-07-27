require('dotenv').config();
const mongoose = require('mongoose');
const Admin = require('./models/Admin');
const News = require('./models/News');

const mongoUri = process.env.MONGODB_URI;

async function approveSubeditorPendingNews() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('✅ Connected to MongoDB successfully');

    // 1. Get all sub-editors
    const subeditors = await Admin.find({ role: 'subeditor' });
    const subeditorIds = subeditors.map(admin => admin._id.toString());
    
    console.log(`Found ${subeditorIds.length} sub-editors.`);

    // 2. Find pending news authored by sub-editors
    // Pending means isActive: false AND not rejected AND not sent back for revision
    const pendingQuery = {
      authorId: { $in: subeditorIds },
      isActive: false,
      $or: [
        { 'rejectionStatus.isRejected': false },
        { 'rejectionStatus.isRejected': { $exists: false } }
      ],
      $or: [
        { 'revisionStatus.needsRevision': false },
        { 'revisionStatus.needsRevision': { $exists: false } }
      ]
    };

    const pendingNewsCount = await News.countDocuments(pendingQuery);
    console.log(`Found ${pendingNewsCount} pending news items authored by sub-editors.`);

    if (pendingNewsCount > 0) {
      // 3. Update them to approved
      const result = await News.updateMany(pendingQuery, {
        $set: {
          isActive: true,
          aiStatus: 'verified', // Mark AI check as verified or bypassed
          'approvalStatus.isApproved': true,
          'approvalStatus.approvedBy': 'System (Bulk Approve)',
          'approvalStatus.approvedByRole': 'admin',
          'approvalStatus.approvedAt': new Date(),
          // Clear any pending media fingerprinting if any (optional, but good practice)
        },
        $push: {
          actionHistory: {
            action: 'approved',
            performedByName: 'System',
            performedByRole: 'admin',
            details: 'Bulk approved pending sub-editor news.',
            performedAt: new Date()
          }
        }
      });

      console.log(`✅ Successfully approved ${result.modifiedCount} news items.`);
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Error approving sub-editor news:', error);
    process.exit(1);
  }
}

approveSubeditorPendingNews();
