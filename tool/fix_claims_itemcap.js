// One-time live fix (run ON server from /var/www/yellowsingam):
//  1) Clear STALE viewEngineCampaignId claims — news locked to a deleted/paused
//     campaign (not the current active one) so the active campaign can onboard them.
//     Existing syntheticViews/likes are NOT touched — only the claim pointer.
//  2) Raise active campaigns' itemCap 500 -> 3000 so more (newest) news participate.
const dotenv = require('/var/www/yellowsingam/node_modules/dotenv');
dotenv.config({ path: '/var/www/yellowsingam/.env' });
const mongoose = require('/var/www/yellowsingam/node_modules/mongoose');

(async () => {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/short_news';
  await mongoose.connect(uri);
  const ViewCampaign = require('/var/www/yellowsingam/services/viewDistribution/models/ViewCampaign');
  const News = require('/var/www/yellowsingam/models/News');

  const activeIds = await ViewCampaign.find({ status: 'active' }).distinct('_id');
  console.log('ACTIVE campaigns:', activeIds.map(String).join(', ') || '(none)');

  // Stale = claim is neither null nor one of the active campaigns.
  const stale = { viewEngineCampaignId: { $nin: activeIds.concat([null]) } };
  const r = await News.updateMany(stale, { $set: { viewEngineCampaignId: null } });
  console.log('STALE claims cleared (news now re-eligible):', r.modifiedCount);

  const cap = await ViewCampaign.updateMany({ status: 'active' }, { $set: { itemCap: 3000 } });
  console.log('itemCap->3000 on active campaigns:', cap.modifiedCount);

  await mongoose.disconnect();
  console.log('DONE');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
