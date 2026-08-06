const mongoose = require('mongoose');
const News = require('./models/News');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(async () => {
    console.log('Connected to DB');
    
    // Find news that are isActive: false, not rejected, and not isDeactivated
    const oldInactive = await News.find({
      isActive: false,
      'rejectionStatus.isRejected': { $ne: true },
      isDeactivated: { $ne: true }
    });
    
    let updatedCount = 0;
    for (const news of oldInactive) {
      // Check if it was ever approved or if it was created by admin (direct publish)
      // We can look at actionHistory
      const history = news.actionHistory || [];
      const hasStatusToggled = history.some(h => h.action === 'status_toggled' || h.action === 'approved');
      
      // If it was created by an admin, it would have been active by default.
      // Wait, if it has 'status_toggled' or 'approved', it's definitely inactive now, not pending.
      // But wait! What if it's pending and was NEVER active?
      
      if (hasStatusToggled) {
        news.isDeactivated = true;
        await news.save();
        updatedCount++;
      } else {
        // If it was created by admin, it was active by default. Then toggled? 
        // If they toggled, it would have 'status_toggled'.
      }
    }
    console.log(`Updated ${updatedCount} old inactive news.`);
    process.exit(0);
  })
  .catch(err => console.error(err));
