const ZodiacDaily = require('../models/ZodiacDaily');
const Language = require('../models/Language');

exports.renderZodiacPage = async (req, res) => {
  try {
    const admin = req.admin;
    const languages = await Language.find({ isActive: true }).sort({ sortOrder: 1, name: 1 });
    
    // Fetch last 7 days of zodiacs to show in a list
    const recentZodiacs = await ZodiacDaily.find()
      .sort({ date: -1, language: 1 })
      .limit(50);

    res.render('zodiac', {
      admin,
      languages,
      recentZodiacs,
      currentPath: '/zodiac'
    });
  } catch (error) {
    console.error('Error rendering zodiac page:', error);
    res.status(500).send('Internal Server Error');
  }
};

exports.saveZodiac = async (req, res) => {
  try {
    const { date, language, chooseTitle, knowTitle, resultTitleFormat, signs } = req.body;
    
    if (!date || !language || !signs || !Array.isArray(signs)) {
      return res.status(400).json({ success: false, message: 'Invalid data provided' });
    }

    let zodiac = await ZodiacDaily.findOne({ date, language });
    
    if (zodiac) {
      zodiac.chooseTitle = chooseTitle;
      zodiac.knowTitle = knowTitle;
      zodiac.resultTitleFormat = resultTitleFormat;
      zodiac.signs = signs;
      await zodiac.save();
    } else {
      zodiac = new ZodiacDaily({
        date,
        language,
        chooseTitle,
        knowTitle,
        resultTitleFormat,
        signs
      });
      await zodiac.save();
    }

    res.json({ success: true, message: 'Zodiac saved successfully' });
  } catch (error) {
    console.error('Error saving zodiac:', error);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
};

// API endpoints for Flutter App
exports.getZodiacToday = async (req, res) => {
  try {
    const { lang } = req.query;
    // Current date in YYYY-MM-DD
    const today = new Date();
    // Adjust timezone if needed, assuming local server time or UTC is fine for now
    // Actually best to let the app send the date or use server date
    const dateStr = req.query.date || today.toISOString().split('T')[0];
    const languageCode = lang || 'te';

    const zodiac = await ZodiacDaily.findOne({ date: dateStr, language: languageCode });
    if (!zodiac) {
      return res.status(404).json({ success: false, message: 'No zodiac found for today' });
    }

    // Add view
    zodiac.views += 1;
    await zodiac.save();

    res.json({ success: true, data: zodiac });
  } catch (error) {
    console.error('Error fetching zodiac today:', error);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
};

exports.likeZodiac = async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, userName } = req.body;

    const zodiac = await ZodiacDaily.findById(id);
    if (!zodiac) return res.status(404).json({ success: false, message: 'Not found' });

    const hasLiked = zodiac.userInteractions.likes.some(u => u.userId === userId);
    if (hasLiked) {
      zodiac.userInteractions.likes = zodiac.userInteractions.likes.filter(u => u.userId !== userId);
      zodiac.likes = Math.max(0, zodiac.likes - 1);
    } else {
      zodiac.userInteractions.likes.push({ userId, userName });
      zodiac.likes += 1;
      
      // Remove dislike if any
      const hasDisliked = zodiac.userInteractions.dislikes.some(u => u.userId === userId);
      if (hasDisliked) {
        zodiac.userInteractions.dislikes = zodiac.userInteractions.dislikes.filter(u => u.userId !== userId);
        zodiac.dislikes = Math.max(0, zodiac.dislikes - 1);
      }
    }
    
    await zodiac.save();
    res.json({ success: true, likes: zodiac.likes, dislikes: zodiac.dislikes });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error' });
  }
};

exports.dislikeZodiac = async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, userName } = req.body;

    const zodiac = await ZodiacDaily.findById(id);
    if (!zodiac) return res.status(404).json({ success: false, message: 'Not found' });

    const hasDisliked = zodiac.userInteractions.dislikes.some(u => u.userId === userId);
    if (hasDisliked) {
      zodiac.userInteractions.dislikes = zodiac.userInteractions.dislikes.filter(u => u.userId !== userId);
      zodiac.dislikes = Math.max(0, zodiac.dislikes - 1);
    } else {
      zodiac.userInteractions.dislikes.push({ userId, userName });
      zodiac.dislikes += 1;
      
      // Remove like if any
      const hasLiked = zodiac.userInteractions.likes.some(u => u.userId === userId);
      if (hasLiked) {
        zodiac.userInteractions.likes = zodiac.userInteractions.likes.filter(u => u.userId !== userId);
        zodiac.likes = Math.max(0, zodiac.likes - 1);
      }
    }
    
    await zodiac.save();
    res.json({ success: true, likes: zodiac.likes, dislikes: zodiac.dislikes });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error' });
  }
};

exports.commentZodiac = async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, userName, comment } = req.body;

    const zodiac = await ZodiacDaily.findById(id);
    if (!zodiac) return res.status(404).json({ success: false, message: 'Not found' });

    zodiac.userInteractions.comments.push({ userId, userName, comment });
    zodiac.comments += 1;
    await zodiac.save();

    res.json({ success: true, comments: zodiac.comments, data: zodiac.userInteractions.comments });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error' });
  }
};

exports.getZodiacComments = async (req, res) => {
  try {
    const { id } = req.params;
    const zodiac = await ZodiacDaily.findById(id);
    if (!zodiac) return res.status(404).json({ success: false, message: 'Not found' });

    // Format comments to match News comments format expected by app
    const formattedComments = zodiac.userInteractions.comments.map(c => ({
      _id: c._id,
      userId: c.userId,
      userName: c.userName,
      comment: c.comment,
      timestamp: c.timestamp,
      likes: [] // Or c.likes if implemented
    }));

    res.json({ success: true, data: formattedComments });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error' });
  }
};
