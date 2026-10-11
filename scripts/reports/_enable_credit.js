require('dotenv').config();
const mongoose = require('mongoose');
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const Admins=db.collection('admins'), News=db.collection('news'), Tx=db.collection('adminwallettransactions');
  const { processWalletTransaction } = require('../../utils/walletHelpers');

  const appr=await News.aggregate([{$match:{'approvalStatus.isApproved':true}},{$project:{aid:{$toString:'$authorId'}}},{$group:{_id:'$aid',c:{$sum:1}}}]).toArray();
  const approvedBy=Object.fromEntries(appr.map(a=>[a._id,a.c]));
  const reps=await Admins.find({ reporterTier:'stringer' }).project({name:1,username:1,mobileNumber:1,walletConfig:1,assignedStates:1,assignedState:1,isActive:1,walletBalance:1}).toArray();
  const targets=reps.filter(d=>{const aid=String(d._id);const approved=approvedBy[aid]||0;const enabled=d.walletConfig&&d.walletConfig.enabled===true;const state=((d.assignedStates&&d.assignedStates[0])||d.assignedState||'').trim();return !enabled&&approved>0&&!/delhi/i.test(state)&&d.isActive!==false;});
  console.log('Targets:', targets.length, '\n');

  let grandCredit=0, grandNews=0;
  for(const d of targets){
    const aid=String(d._id); const idOr={$or:[{adminId:d._id},{adminId:aid}]};
    // 1) enable wallet (per-news mode, like existing stringers)
    await Admins.updateOne({_id:d._id},{$set:{'walletConfig.enabled':true,'walletConfig.dailyTargetNews':null,'walletConfig.dailyRewardAmount':null}});
    // 2) back-credit missing per-news rewards
    const approvedDocs=await News.find({authorId:aid,'approvalStatus.isApproved':true}).project({_id:1}).toArray();
    const rewarded=new Set((await Tx.find({...idOr,type:'credit',referenceId:/^newsreward_/}).project({referenceId:1}).toArray()).map(r=>String(r.referenceId).replace('newsreward_','')));
    const missing=approvedDocs.filter(n=>!rewarded.has(String(n._id)));
    let done=0;
    for(const n of missing){const ref=`newsreward_${String(n._id)}`;if(await Tx.findOne({...idOr,referenceId:ref}))continue;
      await processWalletTransaction({adminId:aid,amount:5,type:'credit',description:'Per-News Reward (stringer) for approved news (back-credit)',referenceId:ref});done++;}
    const after=await Admins.findOne({_id:d._id},{projection:{walletBalance:1}});
    grandCredit+=done*5; grandNews+=done;
    console.log(`✅ ${(d.name||d.username).slice(0,24).padEnd(25)} ${d.mobileNumber||''}  enabled + credited ${String(done).padStart(3)} news = Rs.${String(done*5).padStart(5)}  → balance Rs.${(after&&after.walletBalance)}`);
    try{await db.collection('auditlogs').insertOne({actorName:'script:stringer-enable-backcredit',actorRole:'system',action:'stringer_wallet_enable_backcredit',entityType:'Admin',entityId:aid,targetId:d._id,targetName:d.name||d.username,description:`Wallet enabled + back-credited ${done} news = Rs.${done*5}; balance -> ${(after&&after.walletBalance)}`,createdAt:new Date()});}catch(e){}
  }
  console.log('\n==== DONE ====');
  console.log('Stringers enabled:', targets.length, '| news credited:', grandNews, '| total credited: Rs.'+grandCredit.toLocaleString('en-IN'));
  await mongoose.disconnect();
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
