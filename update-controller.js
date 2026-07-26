const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'controllers/adminController.js');
let code = fs.readFileSync(file, 'utf8');

const newRenderMyAiQueuePage = `
async function renderMyAiQueuePage(req, res) {
  try {
    const adminDoc = await Admin.findById(req.admin.id).select('role workingLanguage permissions').lean();
    
    let selectedLanguage = '';
    const languageParamProvided = Object.prototype.hasOwnProperty.call(req.query, 'language');

    if (!languageParamProvided) {
      if (adminDoc?.role === 'subeditor' && adminDoc?.workingLanguage) {
        selectedLanguage = adminDoc.workingLanguage;
      }
    } else if (req.query.language === 'all') {
      selectedLanguage = '';
    } else {
      selectedLanguage = req.query.language || '';
    }

    const myPendingQuery = {
      isActive: false,
      authorId: String(req.admin.id),
      aiStatus: { $in: ['processing', 'review_required', 'failed'] },
      $or: [
        { 'rejectionStatus.isRejected': { $ne: true } },
        { rejectionStatus: { $exists: false } }
      ]
    };

    if (selectedLanguage) {
      myPendingQuery.$and = [buildNewsLanguageFilter(selectedLanguage)];
    }

    const myPendingNewsRaw = await News.find(myPendingQuery)
      .select('_id title content category location language author authorId publishedAt mediaUrl mediaType thumbnailUrl imageUrl imageUrls readFullLink ePaperLink views duplicateCheck revisionStatus actionHistory aiStatus')
      .lean();

    // Sort My AI Queue by priority, then newest first
    const priorityMap = { 'review_required': 1, 'failed': 2, 'processing': 3 };
    myPendingNewsRaw.sort((a, b) => {
      const pA = priorityMap[a.aiStatus] || 99;
      const pB = priorityMap[b.aiStatus] || 99;
      if (pA !== pB) return pA - pB;
      const dateA = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const dateB = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return dateB - dateA;
    });

    const authorIds = [...new Set(myPendingNewsRaw.map(n => n.authorId).filter(Boolean))];
    const authors = await Admin.find({ _id: { $in: authorIds } }).select('name email mobileNumber constituency').lean();
    const authorMap = {};
    authors.forEach(a => authorMap[a._id.toString()] = a);

    const mapNewsWithDefaults = (newsArray) => newsArray.map(article => {
      let revisionStatus = article.revisionStatus || null;
      if (revisionStatus && revisionStatus.revisionSnapshot) {
        const { revisionSnapshot, ...rest } = revisionStatus;
        revisionStatus = rest;
      }
      return {
        ...article,
        revisionStatus,
        authorDetails: article.authorId ? authorMap[article.authorId.toString()] : null,
        duplicateCheck: normalizeDuplicateCheck(article.duplicateCheck),
      };
    });

    const { getDisplayConfigMap } = require('../services/languageRegistry');

    res.render('my-ai-queue', {
      myPendingNews: mapNewsWithDefaults(myPendingNewsRaw),
      title: 'My AI Queue',
      selectedLanguage,
      admin: req.admin,
      adminRole: adminDoc?.role || req.admin.role,
      displayConfigByLanguage: getDisplayConfigMap(),
      ...(await getLanguageViewData())
    });
  } catch (error) {
    console.error('Error rendering my AI queue page:', error);
    res.status(500).send('Error loading My AI Queue');
  }
}
`;

// Remove myPendingNews from renderPendingNewsPage
const matchPending = code.match(/async function renderPendingNewsPage[\s\S]*?res\.render\('pending-news'[\s\S]*?\}\n\}/);
if (matchPending) {
    let replaced = matchPending[0]
      .replace(/const myPendingQuery = {[\s\S]*?\.lean\(\);/g, '')
      .replace(/\/\/ Sort My AI Queue by priority[\s\S]*?\}\);/g, '')
      .replace(/const allNews = \[\.\.\.teamPendingNewsRaw, \.\.\.myPendingNewsRaw\];/, 'const allNews = [...teamPendingNewsRaw];')
      .replace(/myPendingNews: mapNewsWithDefaults\(myPendingNewsRaw\),/, '');
      
    code = code.replace(matchPending[0], replaced + "\n\n" + newRenderMyAiQueuePage);
    code = code.replace(/module\.exports = \{/, 'module.exports = {\n  renderMyAiQueuePage,');
    fs.writeFileSync(file, code);
    console.log('Controller updated successfully.');
} else {
    console.error('Regex failed to match renderPendingNewsPage');
}
