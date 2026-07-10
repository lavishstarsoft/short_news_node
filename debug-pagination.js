const mongoose = require('mongoose');
const News = require('./models/News');
const Admin = require('./models/Admin');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const admin = await Admin.findOne({ role: 'subeditor' });
  
  // Find reporters in assigned locations
  const assignedLocations = admin.permissions.managedLocations;
  const assignedReporters = await Admin.find({ 
      role: { $in: ['editor', 'reporter'] }, 
      $or: [
          { location: { $in: assignedLocations } },
          { assignedLocations: { $in: assignedLocations } }
      ]
  }).select('_id');
  
  const assignedReporterIds = assignedReporters.map(r => r._id.toString());
  
  const subEditorQuery = {
      $or: [
          { authorId: admin._id.toString() },
          { authorId: { $in: assignedReporterIds } }
      ]
  };

  const newsList = await News.find(subEditorQuery)
    .sort({ publishedAt: -1 })
    .limit(21);
    
  let myArticlesCount = 0;
  let teamArticlesCount = 0;
  
  newsList.forEach(n => {
    if (n.authorId && n.authorId.toString() === admin._id.toString()) {
        myArticlesCount++;
    } else {
        teamArticlesCount++;
    }
  });
  
  console.log('Total in first page:', newsList.length);
  console.log('My articles in first page:', myArticlesCount);
  console.log('Team articles in first page:', teamArticlesCount);
  
  process.exit();
});
