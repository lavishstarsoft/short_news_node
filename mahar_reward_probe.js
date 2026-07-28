/* READ-ONLY diagnostic for the ₹30 reward. No writes. No app code changed.
   Place this file in the Node/ folder and run:  node mahar_reward_probe.js
   Optional: node mahar_reward_probe.js "Mahar Khan"                         */
require('dotenv').config();
const mongoose = require('mongoose');
const Admin = require('./models/Admin');
const News = require('./models/News');
const AppSettings = require('./models/AppSettings');
const AdminWalletTransaction = require('./models/AdminWalletTransaction');
const { resolveWalletConfig } = require('./utils/walletHelpers');

const NEEDLE = process.argv[2] || 'Mahar';

(async () => {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/short_news');
    console.log('CONNECTED. server TZ =', Intl.DateTimeFormat().resolvedOptions().timeZone, '| now =', new Date().toString());

    const admins = await Admin.find({
        $or: [
            { name: { $regex: NEEDLE, $options: 'i' } },
            { username: { $regex: NEEDLE, $options: 'i' } }]
    }).lean();
    if (!admins.length) { console.log('NO MATCH for', NEEDLE); return mongoose.disconnect(); }

    const settings = await AppSettings.findOne({ key: 'update_flags' }).lean(); // exact query the code uses
    const anySettings = await AppSettings.findOne({}).lean();

    for (const a of admins) {
        const id = String(a._id);
        console.log('\n=== Reporter:', a.name || a.username, '| role:', a.role, '| _id:', id, '===');
        console.log('admin.walletConfig.dailyTargetNews   =', a.walletConfig && a.walletConfig.dailyTargetNews);
        console.log('admin.walletConfig.dailyRewardAmount =', a.walletConfig && a.walletConfig.dailyRewardAmount, '(field for "maxDailyReward")');
        console.log('admin.walletConfig.enabled           =', a.walletConfig && a.walletConfig.enabled, '| walletBalance =', a.walletBalance);
        console.log('AppSettings(key=update_flags) found?  =', !!settings);
        console.log('AppSettings.reporterTargetNews       =', (settings && settings.reporterTargetNews), '| (any doc) =', anySettings && anySettings.reporterTargetNews);
        console.log('AppSettings.reporterMaxDailyReward   =', (settings && settings.reporterMaxDailyReward), '| (any doc) =', anySettings && anySettings.reporterMaxDailyReward);

        const r = resolveWalletConfig(a, settings);
        console.log('resolveWalletConfig -> enabled:', r.enabled, '| targetNews:', r.targetNews, '| maxReward:', r.maxReward);

        const s = new Date(); s.setHours(0, 0, 0, 0);
        const e = new Date(); e.setHours(23, 59, 59, 999);
        const approvedCount = await News.countDocuments({
            authorId: id, isActive: true,
            'approvalStatus.isApproved': true, 'approvalStatus.approvedAt': { $gte: s, $lte: e }
        });
        const referenceId = 'reward_' + id + '_' + s.toISOString().split('T')[0];
        const existingTx = await AdminWalletTransaction.findOne({ referenceId }).lean();

        console.log('approvedCount (today)   =', approvedCount, '| window', s.toISOString(), '->', e.toISOString());
        console.log('targetNews              =', r.targetNews);
        console.log('maxReward               =', r.maxReward);
        console.log('rewardEligible          =', approvedCount >= r.targetNews, '(' + approvedCount + ' >= ' + r.targetNews + ')');
        console.log('referenceId (today)     =', referenceId);
        console.log('rewardAlreadyExists     =', !!existingTx);

        const txs = await AdminWalletTransaction.find({
            adminId: a._id, $or: [
                { referenceId: { $regex: '^reward_' } }, { description: { $regex: 'Daily Reward', $options: 'i' } }]
        }).sort({ createdAt: -1 }).limit(10).lean();
        console.log('--- actual daily-reward transactions (latest 10) ---');
        if (!txs.length) console.log('   (none)');
        txs.forEach(t => console.log('  Rs' + t.amount, t.type, '| ' + t.description, '| ref=' + t.referenceId,
            '| balAfter=' + t.balanceAfter, '| ' + new Date(t.createdAt).toISOString()));
    }
    await mongoose.disconnect();
})().catch(err => { console.error('ERROR:', err.message); process.exit(1); });