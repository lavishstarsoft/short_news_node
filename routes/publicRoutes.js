const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const News = require('../models/News');
const User = require('../models/User');
const Location = require('../models/Location');
const Report = require('../models/Report');
const Ad = require('../models/Ad');
const ViralVideo = require('../models/ViralVideo');
const CommentReport = require('../models/CommentReport');
const Admin = require('../models/Admin');
const zodiacController = require('../controllers/zodiacController');

// Import cache middleware for Redis caching
const { cacheMiddleware, clearCache } = require('../middleware/cache');

// Import upload middleware for profile image upload
const { uploadMedia, uploadRegistrationMedia } = require('../middleware/upload');
const { verifyMobileUser } = require('../middleware/mobileAuth');

// Strip PII (email) from interaction arrays before returning them publicly.
const stripEmails = (list) => (list || []).map(({ userEmail, ...rest }) => rest);

// 🚀 SCALABILITY: cap how many items a single public feed response returns.
// Previously these queries were unbounded and would load the ENTIRE collection
// into memory on every (cache-miss) request. The feed is sorted newest-first,
// so users still get the most recent items; tune via PUBLIC_FEED_MAX.
const FEED_MAX = Number(process.env.PUBLIC_FEED_MAX) || 300;
const { buildNewsLanguageFilter } = require('../utils/newsLanguages');
const { resolveCategoryFilter, resolveLocationFilter } = require('../utils/newsFilters');
const languageRegistry = require('../services/languageRegistry');
const fs = require('fs');


// Public API endpoint for Flutter app (no authentication required)
// Cached for 10 minutes (600 seconds)
const handleGetNews = async (req, res) => {
  try {
    let newsList;
    const { language } = req.query;

    // Check if MongoDB is connected
    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;

    if (isConnectedToMongoDB) {
      const query = { isActive: { $ne: false } };
      if (language) {
        Object.assign(query, buildNewsLanguageFilter(language));
      }
      newsList = await News.find(query).sort({ publishedAt: -1 }).limit(FEED_MAX);
    } else {
      // Use in-memory storage and filter for active news
      const allNews = req.app.locals.newsData || [];
      newsList = allNews
        .filter(news => {
          if (news.isActive === false) return false;
          if (!language) return true;
          const normalized = String(language).toLowerCase();
          const articleLanguage = (news.language || 'te').toLowerCase();
          return articleLanguage === normalized || (normalized === 'te' && !news.language);
        })
        .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    }

    // Transform data for Flutter app with backward compatibility
    const transformedNews = newsList.map(news => {
      const newsObj = news.toObject ? news.toObject() : news;
      const imageUrl = newsObj.thumbnailUrl || newsObj.mediaUrl || newsObj.imageUrl || '/images/placeholder.png';
      
      return {
        id: newsObj._id,
        _id: newsObj._id, // Backward compatibility
        title: newsObj.title,
        content: newsObj.content,
        imageUrl: imageUrl,
        image_url: imageUrl, // Backward compatibility
        mediaUrl: newsObj.mediaUrl || newsObj.imageUrl || '/images/placeholder.png',
        media_url: newsObj.mediaUrl || newsObj.imageUrl || '/images/placeholder.png', // Backward compatibility
        mediaType: newsObj.mediaType || 'image',
        media_type: newsObj.mediaType || 'image', // Backward compatibility
        thumbnailUrl: newsObj.thumbnailUrl || newsObj.mediaUrl || newsObj.imageUrl || '/images/placeholder.png',
        thumbnail_url: newsObj.thumbnailUrl || newsObj.mediaUrl || newsObj.imageUrl || '/images/placeholder.png', // Backward compatibility
        category: newsObj.category,
        location: newsObj.location,
        language: newsObj.language || 'te',
        publishedAt: newsObj.publishedAt,
        published_at: newsObj.publishedAt, // Backward compatibility
        likes: newsObj.likes || 0,
        dislikes: newsObj.dislikes || 0,
        views: newsObj.views || 0,
        comments: newsObj.comments || 0,
        author: newsObj.author,
        isRead: newsObj.isRead || false,
        readFullLink: newsObj.readFullLink || null,
        ePaperLink: newsObj.ePaperLink || null,
        // Include user interaction details
        userLikes: stripEmails(newsObj.userInteractions?.likes),
        userDislikes: stripEmails(newsObj.userInteractions?.dislikes),
        userComments: (newsObj.userInteractions?.comments || []).map(comment => ({
          userId: comment.userId,
          userName: comment.userName,
          comment: comment.comment,
          timestamp: comment.timestamp,
          likes: comment.likes || []
        }))
      };
    });

    res.json(transformedNews);
  } catch (error) {
    console.error('Error fetching public news:', error);
    res.status(500).json({ error: 'Error fetching news' });
  }
};

router.get('/api/public/news', handleGetNews);
router.post('/api/public/news', handleGetNews);

// Public API endpoint for Flutter app with category filter (no authentication required)
router.get('/api/public/news/category/:category', async (req, res) => {
  try {
    const { category } = req.params;
    let newsList;

    // Check if MongoDB is connected
    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;

    if (isConnectedToMongoDB) {
      const resolvedCategory = await resolveCategoryFilter(decodeURIComponent(category));
      const query = { isActive: { $ne: false } };
      if (resolvedCategory) {
        query.category = resolvedCategory;
      }

      newsList = await News.find(query).sort({ publishedAt: -1 }).limit(FEED_MAX);
    } else {
      // Use in-memory storage and filter for active news with category filter
      const allNews = req.app.locals.newsData || [];
      newsList = allNews
        .filter(news => news.isActive !== false && news.category === category)
        .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)); // Sort by publishedAt descending (newest first)
    }

    // Transform data for Flutter app
    const transformedNews = newsList.map(news => {
      const newsObj = news.toObject ? news.toObject() : news;
      return {
        id: newsObj._id,
        title: newsObj.title,
        content: newsObj.content,
        imageUrl: newsObj.thumbnailUrl || newsObj.mediaUrl || newsObj.imageUrl || '/images/placeholder.png',
        mediaUrl: newsObj.mediaUrl || newsObj.imageUrl || '/images/placeholder.png',
        mediaType: newsObj.mediaType || 'image',
        category: newsObj.category,
        location: newsObj.location,
        publishedAt: newsObj.publishedAt,
        likes: newsObj.likes || 0,
        dislikes: newsObj.dislikes || 0,
        views: newsObj.views || 0,
        comments: newsObj.comments || 0,
        author: newsObj.author,
        isRead: newsObj.isRead || false,
        readFullLink: newsObj.readFullLink || null,
        ePaperLink: newsObj.ePaperLink || null,
        // Include user interaction details
        userLikes: stripEmails(newsObj.userInteractions?.likes),
        userDislikes: stripEmails(newsObj.userInteractions?.dislikes),
        userComments: (newsObj.userInteractions?.comments || []).map(comment => ({
          userId: comment.userId,
          userName: comment.userName,
          comment: comment.comment,
          timestamp: comment.timestamp,
          likes: comment.likes || [] // Include likes array
        }))
      };
    });

    res.json(transformedNews);
  } catch (error) {
    console.error('Error fetching public news by category:', error);
    res.status(500).json({ error: 'Error fetching news by category' });
  }
});

// Public API endpoint for Flutter app with location filter (no authentication required)
// Cached for 10 minutes (600 seconds)
router.get('/api/public/news/location/:location', cacheMiddleware(600), async (req, res) => {
  try {
    const { location } = req.params;
    let newsList;

    // Check if MongoDB is connected
    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;

    if (isConnectedToMongoDB) {
      const resolvedLocation = await resolveLocationFilter(decodeURIComponent(location));
      const query = { isActive: { $ne: false } };
      if (resolvedLocation) {
        query.location = resolvedLocation;
      }

      newsList = await News.find(query).sort({ publishedAt: -1 }).limit(FEED_MAX);
    } else {
      // Use in-memory storage and filter for active news with location filter
      const allNews = req.app.locals.newsData || [];
      newsList = allNews
        .filter(news => news.isActive !== false && news.location === location)
        .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)); // Sort by publishedAt descending (newest first)
    }

    // Transform data for Flutter app
    const transformedNews = newsList.map(news => {
      const newsObj = news.toObject ? news.toObject() : news;
      return {
        id: newsObj._id,
        title: newsObj.title,
        content: newsObj.content,
        imageUrl: newsObj.thumbnailUrl || newsObj.mediaUrl || newsObj.imageUrl || '/images/placeholder.png',
        mediaUrl: newsObj.mediaUrl || newsObj.imageUrl || '/images/placeholder.png',
        mediaType: newsObj.mediaType || 'image',
        category: newsObj.category,
        location: newsObj.location,
        publishedAt: newsObj.publishedAt,
        likes: newsObj.likes || 0,
        dislikes: newsObj.dislikes || 0,
        views: newsObj.views || 0,
        comments: newsObj.comments || 0,
        author: newsObj.author,
        isRead: newsObj.isRead || false,
        readFullLink: newsObj.readFullLink || null,
        ePaperLink: newsObj.ePaperLink || null,
        // Include user interaction details
        userLikes: stripEmails(newsObj.userInteractions?.likes),
        userDislikes: stripEmails(newsObj.userInteractions?.dislikes),
        userComments: (newsObj.userInteractions?.comments || []).map(comment => ({
          userId: comment.userId,
          userName: comment.userName,
          comment: comment.comment,
          timestamp: comment.timestamp,
          likes: comment.likes || [] // Include likes array
        }))
      };
    });

    res.json(transformedNews);
  } catch (error) {
    console.error('Error fetching public news by location:', error);
    res.status(500).json({ error: 'Error fetching news by location' });
  }
});

// New endpoint for user interactions (like, dislike, comment) with Google authentication
router.post('/api/public/news/:id/interact', verifyMobileUser, async (req, res) => {
  try {
    const { id } = req.params;
    const { action, userId, userName, userEmail, commentText } = req.body;

    // Validate required fields
    if (!action || !userId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate action
    if (!['like', 'dislike', 'comment', 'unlike', 'undislike', 'delete_comment', 'like_comment'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    // Additional validation: prevent empty user data
    if (!userName || userName.trim() === '') {
      return res.status(400).json({ error: 'User name is required' });
    }

    console.log(`📊 User interaction: ${action} by ${userName} (${userId}) on news ${id}`);

    // Check if MongoDB is connected by trying to access the connection
    const isConnectedToMongoDB = mongoose.connection.readyState === 1;

    let news;
    if (isConnectedToMongoDB) {
      // Find the news item in MongoDB
      news = await News.findById(id);
      if (!news) {
        return res.status(404).json({ error: 'News not found' });
      }

      // Find or create user in database  
      let user = await User.findOne({ googleId: userId });
      if (!user && userName && userEmail) {
        // Create new user if doesn't exist
        user = new User({
          googleId: userId,
          displayName: userName,
          email: userEmail,
          lastLogin: new Date()
        });
      } else if (user) {
        // Update existing user info
        user.displayName = userName || user.displayName;
        user.email = userEmail || user.email;
        user.lastLogin = new Date();
      }

      // Save user if created or updated
      if (user) {
        await user.save();
      }

      // Update the interaction count and store user details based on action
      switch (action) {
        case 'like':
          // Check if user has already disliked this news
          const existingDislikeIndex = news.userInteractions.dislikes.findIndex(dislike => dislike.userId === userId);
          if (existingDislikeIndex !== -1) {
            // User is changing from dislike to like
            news.dislikes -= 1;
            news.userInteractions.dislikes.splice(existingDislikeIndex, 1);

            // Remove from user's dislikes if user exists
            if (user) {
              const userDislikeIndex = user.interactions.dislikes.findIndex(dislikeId => String(dislikeId) === String(news._id));
              if (userDislikeIndex !== -1) {
                user.interactions.dislikes.splice(userDislikeIndex, 1);
              }
            }
          }

          // Check if user has already liked this news
          const existingLikeIndex = news.userInteractions.likes.findIndex(like => like.userId === userId);

          console.log(`🔍 Like check: User ${userId} existing like index: ${existingLikeIndex}`);

          if (existingLikeIndex === -1) {
            // User is adding a new like
            console.log(`➕ Adding new like for user ${userName}`);
            news.likes += 1;
            news.userInteractions.likes.push({
              userId: userId,
              userName: userName || 'User',
              userEmail: userEmail || '',
              timestamp: new Date()
            });

            // Add to user's interactions if user exists
            if (user && !user.interactions.likes.map(String).includes(String(news._id))) {
              user.interactions.likes.push(news._id);
            }
            console.log(`✅ Like added successfully. Total likes: ${news.likes}`);
          } else {
            // User is removing their like (unliking)
            console.log(`➖ Removing existing like for user ${userName}`);
            news.likes = Math.max(0, news.likes - 1); // Prevent negative values
            news.userInteractions.likes.splice(existingLikeIndex, 1);

            console.log(`✅ Like removed successfully. Total likes: ${news.likes}`);

            // Remove from user's likes if user exists
            if (user) {
              const userLikeIndex = user.interactions.likes.findIndex(likeId => String(likeId) === String(news._id));
              if (userLikeIndex !== -1) {
                user.interactions.likes.splice(userLikeIndex, 1);
              }
            }
          }
          break;

        case 'dislike':
          console.log(`👎 Processing dislike action for user ${userName}`);

          // Check if user has already liked this news
          const existingLikeIndex2 = news.userInteractions.likes.findIndex(like => like.userId === userId);
          if (existingLikeIndex2 !== -1) {
            // User is changing from like to dislike
            console.log(`🔄 User switching from like to dislike`);
            news.likes = Math.max(0, news.likes - 1); // Prevent negative values
            news.userInteractions.likes.splice(existingLikeIndex2, 1);

            // Remove from user's likes if user exists
            if (user) {
              const userLikeIndex = user.interactions.likes.findIndex(likeId => String(likeId) === String(news._id));
              if (userLikeIndex !== -1) {
                user.interactions.likes.splice(userLikeIndex, 1);
              }
            }
          }

          // Check if user has already disliked this news
          const existingDislikeIndex2 = news.userInteractions.dislikes.findIndex(dislike => dislike.userId === userId);
          if (existingDislikeIndex2 === -1) {
            // User is adding a new dislike
            news.dislikes += 1;
            news.userInteractions.dislikes.push({
              userId: userId,
              userName: userName || 'User',
              userEmail: userEmail || '',
              timestamp: new Date()
            });

            // Add to user's interactions if user exists
            if (user && !user.interactions.dislikes.map(String).includes(String(news._id))) {
              user.interactions.dislikes.push(news._id);
            }
          } else {
            // User is removing their dislike (undisliking)
            news.dislikes -= 1;
            news.userInteractions.dislikes.splice(existingDislikeIndex2, 1);

            // Remove from user's dislikes if user exists
            if (user) {
              const userDislikeIndex = user.interactions.dislikes.findIndex(dislikeId => String(dislikeId) === String(news._id));
              if (userDislikeIndex !== -1) {
                user.interactions.dislikes.splice(userDislikeIndex, 1);
              }
            }
          }
          break;

        case 'unlike':
          // Handle explicit unlike action (same as removing a like)
          const likeIndex = news.userInteractions.likes.findIndex(like => like.userId === userId);
          if (likeIndex !== -1) {
            news.likes -= 1;
            news.userInteractions.likes.splice(likeIndex, 1);

            // Remove from user's likes if user exists
            if (user) {
              const userLikeIndex = user.interactions.likes.findIndex(likeId => String(likeId) === String(news._id));
              if (userLikeIndex !== -1) {
                user.interactions.likes.splice(userLikeIndex, 1);
              }
            }
          }
          break;

        case 'undislike':
          // Handle explicit undislike action (same as removing a dislike)
          const dislikeIndex = news.userInteractions.dislikes.findIndex(dislike => dislike.userId === userId);
          if (dislikeIndex !== -1) {
            news.dislikes -= 1;
            news.userInteractions.dislikes.splice(dislikeIndex, 1);

            // Remove from user's dislikes if user exists  
            if (user) {
              const userDislikeIndex = user.interactions.dislikes.findIndex(dislikeId => String(dislikeId) === String(news._id));
              if (userDislikeIndex !== -1) {
                user.interactions.dislikes.splice(userDislikeIndex, 1);
              }
            }
          }
          break;

        case 'delete_comment':
          if (!commentText) {
            return res.status(400).json({ error: 'Comment text is required for deletion' });
          }

          if (news.userInteractions && news.userInteractions.comments) {
            // Find comment by user and text
            const commentIndex = news.userInteractions.comments.findIndex(c =>
              String(c.userId) === String(userId) && c.comment === commentText
            );

            if (commentIndex !== -1) {
              news.userInteractions.comments.splice(commentIndex, 1);
              news.comments = Math.max(0, news.comments - 1);
              console.log(`🗑️ Comment deleted for user ${userName}`);
            } else {
              console.log(`⚠️ Comment not found for deletion: ${commentText}`);
            }
          }

          // Remove from user's interactions if user exists
          if (user && user.interactions && user.interactions.comments) {
            const userCommentIndex = user.interactions.comments.findIndex(c =>
              String(c.newsId) === String(news._id) && c.comment === commentText
            );

            if (userCommentIndex !== -1) {
              user.interactions.comments.splice(userCommentIndex, 1);
            }
          }
          break;

        case 'comment':
          if (!commentText) {
            return res.status(400).json({ error: 'Comment text is required' });
          }
          news.comments += 1;
          if (!news.userInteractions) {
            news.userInteractions = { likes: [], dislikes: [], comments: [] };
          }
          news.userInteractions.comments.push({
            userId: userId,
            userName: userName || 'User',
            userEmail: userEmail || '',
            comment: commentText,
            timestamp: new Date()
          });

          // Add to user's interactions if user exists
          if (user) {
            user.interactions.comments.push({
              newsId: news._id,
              comment: commentText,
              timestamp: new Date()
            });
          }
          break;

        case 'like_comment':
          if (!commentText) {
            return res.status(400).json({ error: 'Comment text is required to like' });
          }

          if (news.userInteractions && news.userInteractions.comments) {
            // Find the comment by text (can be anyone's comment)
            const comment = news.userInteractions.comments.find(c =>
              c.comment === commentText
            );

            if (comment) {
              // Initialize likes array if it doesn't exist
              if (!comment.likes) {
                comment.likes = [];
              }

              // Check if user already liked this comment
              const likeIndex = comment.likes.findIndex(like =>
                String(like.userId) === String(userId)
              );

              if (likeIndex === -1) {
                // Add like
                comment.likes.push({
                  userId: userId,
                  userName: userName || 'User',
                  timestamp: new Date()
                });
                console.log(`❤️ Comment liked by ${userName}`);
                console.log(`📊 Comment now has ${comment.likes.length} likes:`, comment.likes.map(l => l.userName));
              } else {
                // Remove like (unlike)
                comment.likes.splice(likeIndex, 1);
                console.log(`💔 Comment unliked by ${userName}`);
                console.log(`📊 Comment now has ${comment.likes.length} likes`);
              }

              // Mark the comment subdocument as modified
              news.markModified('userInteractions.comments');
              console.log(`🔄 Marked userInteractions.comments as modified for save`);
            } else {
              console.log(`⚠️ Comment not found for liking`);
            }
          }
          break;
      }

      // Save both the updated news item and user (if user exists)
      const savePromises = [news.save()];
      if (user) {
        savePromises.push(user.save());
      }
      await Promise.all(savePromises);

      // 🔄 Clear news cache after interaction to ensure accurate counts
      await clearCache('cache:/api/public/news*');
      await clearCache('cache:/api/public/news');

      // Verify save for like_comment action
      if (action === 'like_comment') {
        console.log(`✅ News saved successfully. Verifying comment likes persisted...`);
        const savedNews = await News.findById(id);
        const savedComment = savedNews.userInteractions.comments.find(c => c.comment === commentText);
        if (savedComment && savedComment.likes) {
          console.log(`✅ Verified: Comment has ${savedComment.likes.length} likes in DB`);
        } else {
          console.log(`⚠️ Warning: Comment likes not found in DB after save!`);
        }
      }
    } else {
      // Use in-memory storage
      const newsData = req.app.locals.newsData || [];
      const newsIndex = newsData.findIndex(newsItem => newsItem._id === id);

      if (newsIndex === -1) {
        return res.status(404).json({ error: 'News not found' });
      }

      // For in-memory storage, we'll just update the counts
      // Note: In-memory storage doesn't track individual user interactions,
      // so we can't properly handle vote changes in this mode
      switch (action) {
        case 'like':
        case 'unlike':
          // Simple implementation for in-memory storage - just increment/decrement likes
          // In a real implementation, you would need to track user interactions
          if (action === 'like') {
            newsData[newsIndex].likes += 1;
          } else {
            newsData[newsIndex].likes = Math.max(0, newsData[newsIndex].likes - 1);
          }
          break;
        case 'dislike':
        case 'undislike':
          // Simple implementation for in-memory storage - just increment/decrement dislikes
          // In a real implementation, you would need to track user interactions
          if (action === 'dislike') {
            newsData[newsIndex].dislikes += 1;
          } else {
            newsData[newsIndex].dislikes = Math.max(0, newsData[newsIndex].dislikes - 1);
          }
          break;
        case 'comment':
          if (!commentText) {
            return res.status(400).json({ error: 'Comment text is required' });
          }
          newsData[newsIndex].comments += 1;
          break;
      }

      // Update the news data in app locals
      req.app.locals.newsData = newsData;
      news = newsData[newsIndex];
    }

    // Return the updated news item
    const transformedNews = {
      id: news._id,
      title: news.title,
      content: news.content,
      imageUrl: news.thumbnailUrl || news.mediaUrl || news.imageUrl || '/images/placeholder.png',
      mediaUrl: news.mediaUrl || news.imageUrl || '/images/placeholder.png',
      mediaType: news.mediaType || 'image',
      category: news.category,
      location: news.location,
      publishedAt: news.publishedAt,
      likes: news.likes,
      dislikes: news.dislikes,
      views: news.views || 0,
      comments: news.comments,
      author: news.author,
      isRead: news.isRead || false,
      readFullLink: news.readFullLink || null,
      ePaperLink: news.ePaperLink || null,
      // Include user interaction details
      userLikes: stripEmails(news.userInteractions?.likes),
      userDislikes: stripEmails(news.userInteractions?.dislikes),
      userComments: (news.userInteractions?.comments || []).map(comment => ({
        userId: comment.userId,
        userName: comment.userName,
        comment: comment.comment,
        timestamp: comment.timestamp,
        likes: comment.likes || [] // Explicitly include likes array
      }))
    };

    res.json(transformedNews);
  } catch (error) {
    console.error('Error processing interaction:', error);
    res.status(500).json({ error: 'Error processing interaction' });
  }
});

// New endpoint to get user profile data
router.post('/api/public/user/profile', async (req, res) => {
  try {
    const { userId, userName, userEmail } = req.body;

    // Check if required fields are provided
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Check if MongoDB is connected by trying to access the connection
    const isConnectedToMongoDB = mongoose.connection.readyState === 1;

    let user = null;
    if (isConnectedToMongoDB) {
      try {
        const User = require('../models/User');

        // Try to find existing user by various ID types
        const query = { $or: [] };
        if (userId) query.$or.push({ googleId: userId });
        if (userEmail) query.$or.push({ email: userEmail });
        if (req.body.mobileNumber) query.$or.push({ mobileNumber: req.body.mobileNumber });

        // Ensure query is valid
        if (query.$or.length > 0) {
          user = await User.findOne(query);
        }

        if (!user) {
          // Create new user if doesn't exist
          user = new User({
            displayName: userName || 'User',
            lastLogin: new Date(),
            photoUrl: req.body.photoUrl || null
          });

          if (userId && !userEmail && !req.body.mobileNumber) user.googleId = userId; // Google login
          else if (userId) user.googleId = userId; // Could be from Google

          if (userEmail) user.email = userEmail;
          if (req.body.mobileNumber) user.mobileNumber = req.body.mobileNumber;

          await user.save();
          console.log('Created new user:', user);
        } else {
          // Update existing user info
          user.displayName = userName || user.displayName;
          if (userEmail) user.email = userEmail;
          if (req.body.mobileNumber) user.mobileNumber = req.body.mobileNumber;
          user.lastLogin = new Date();
          if (req.body.photoUrl) {
            user.photoUrl = req.body.photoUrl;
          }
          await user.save();

          // Populate interactions to get full news details
          await user.populate([
            { path: 'interactions.likes', select: 'title category publishedAt' },
            { path: 'interactions.dislikes', select: 'title category publishedAt' },
            { path: 'interactions.comments.newsId', select: 'title' }
          ]);
        }
      } catch (dbError) {
        console.error('Database error in user profile:', dbError);
        return res.status(500).json({ error: 'Database error' });
      }
    }

    // Format the interactions data for the frontend
    const formattedInteractions = {
      likes: [],
      dislikes: [],
      comments: []
    };

    if (user && user.interactions) {
      // Helper to format news interaction
      const formatNews = (news) => {
        if (!news || !news._id) return null;
        return {
          id: news._id.toString(),
          title: news.title || '',
          category: news.category || '',
          publishedAt: news.publishedAt ? news.publishedAt.toISOString() : new Date().toISOString()
        };
      };

      // Format likes
      if (user.interactions.likes && Array.isArray(user.interactions.likes)) {
        formattedInteractions.likes = user.interactions.likes
          .map(formatNews)
          .filter(item => item !== null);
      }

      // Format dislikes
      if (user.interactions.dislikes && Array.isArray(user.interactions.dislikes)) {
        formattedInteractions.dislikes = user.interactions.dislikes
          .map(formatNews)
          .filter(item => item !== null);
      }

      // Format comments
      if (user.interactions.comments && Array.isArray(user.interactions.comments)) {
        formattedInteractions.comments = user.interactions.comments.map(comment => {
          const news = comment.newsId; // Populated news object
          return {
            newsId: news && news._id ? news._id.toString() : (comment.newsId ? comment.newsId.toString() : ''),
            newsTitle: news && news.title ? news.title : 'Unknown News',
            comment: comment.comment || '',
            timestamp: comment.timestamp ? comment.timestamp.toISOString() : new Date().toISOString()
          };
        });
      }
    }

    // Return user profile data with complete structure
    const responseData = {
      userId: userId,
      displayName: userName || 'User',
      email: userEmail || '',
      photoUrl: req.body.photoUrl || null,
      createdAt: user?.createdAt?.toISOString() || new Date().toISOString(),
      lastLogin: user?.lastLogin?.toISOString() || new Date().toISOString(),
      stats: {
        likes: formattedInteractions.likes.length,
        dislikes: formattedInteractions.dislikes.length,
        comments: formattedInteractions.comments.length
      },
      interactions: formattedInteractions
    };

    console.log('Sending user profile response:', JSON.stringify(responseData, null, 2));
    res.json(responseData);
  } catch (error) {
    console.error('Error in user profile endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Public API endpoint for fetching active languages (no authentication required)
// Cached for 30 minutes (1800 seconds)
router.get('/api/public/languages', cacheMiddleware(300), async (req, res) => {
  try {
    await languageRegistry.refreshCache();
    const forUserApp =
      req.query.forUserApp === 'true' ||
      req.query.forUserApp === '1' ||
      req.query.forUserApp === true;

    const languages = forUserApp
      ? languageRegistry.getUserAppLanguages()
      : languageRegistry.getActiveLanguages();

    res.json(
      languages.map((language) => ({
        code: language.code,
        name: language.name,
        nativeName: language.nativeName,
        isDefault: language.isDefault === true
      }))
    );
  } catch (error) {
    console.error('Error fetching public languages:', error);
    res.status(500).json({ error: 'Error fetching languages' });
  }
});

router.get('/api/public/news-display-config', cacheMiddleware(300), async (req, res) => {
  try {
    await languageRegistry.refreshCache();
    const map = languageRegistry.getDisplayConfigMap();
    res.json(
      Object.entries(map).map(([code, config]) => ({
        code,
        ...config,
      }))
    );
  } catch (error) {
    console.error('Error fetching public news display config:', error);
    res.status(500).json({ error: 'Error fetching news display config' });
  }
});

// Public API endpoint for fetching locations (no authentication required)
// Cached for 30 minutes (1800 seconds) - locations rarely change
router.get('/api/public/locations', cacheMiddleware(1800), async (req, res) => {
  try {
    // Check if MongoDB is connected
    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;

    if (isConnectedToMongoDB) {
      // Fetch all locations from MongoDB
      const locations = await Location.find().sort({ name: 1 });

      // Calculate news count for each location
      const locationsWithNewsCount = await Promise.all(locations.map(async (location) => {
        const newsCount = await News.countDocuments({ location: location.name });
        return {
          ...location.toObject(),
          newsCount
        };
      }));

      res.json(locationsWithNewsCount);
    } else {
      // Use in-memory storage
      const locations = req.app.locals.locationData || [];

      // Calculate news count for each location
      const newsData = req.app.locals.newsData || [];
      const locationsWithNewsCount = locations.map(location => {
        const newsCount = newsData.filter(news => news.location === location.name).length;
        return {
          ...location,
          newsCount
        };
      });

      res.json(locationsWithNewsCount);
    }
  } catch (error) {
    console.error('Error fetching public locations:', error);
    res.status(500).json({ error: 'Error fetching locations' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Location Hierarchy API — returns states with their districts
// Cached for 1 hour — hierarchy rarely changes
// ──────────────────────────────────────────────────────────────────────────────
router.get('/api/public/location-hierarchy', cacheMiddleware(3600), async (req, res) => {
  try {
    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;
    if (!isConnectedToMongoDB) {
      return res.json([]);
    }

    const hierarchy = await Location.getHierarchy();
    res.json(hierarchy);
  } catch (error) {
    console.error('Error fetching location hierarchy:', error);
    res.status(500).json({ error: 'Error fetching location hierarchy' });
  }
});

// Districts for a specific state
router.get('/api/public/locations/districts/:stateName', cacheMiddleware(3600), async (req, res) => {
  try {
    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;
    if (!isConnectedToMongoDB) {
      return res.json([]);
    }

    const stateName = decodeURIComponent(req.params.stateName);
    const districts = await Location.getDistrictsForState(stateName);
    res.json(districts);
  } catch (error) {
    console.error('Error fetching districts:', error);
    res.status(500).json({ error: 'Error fetching districts' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Smart News Feed API — Interleaved location-based feed (News Gravity)
// ──────────────────────────────────────────────────────────────────────────────
router.get('/api/public/news/smart-feed', cacheMiddleware(120), async (req, res) => {
  try {
    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;
    if (!isConnectedToMongoDB) {
      return res.json([]);
    }

    const { state: reqState, district: reqDistrict, language, page, limit: limitParam, category, manualLocation } = req.query;
    const lang = language || 'te';
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limit = Math.min(50, Math.max(5, parseInt(limitParam) || 20));

    let state = reqState;
    let district = reqDistrict;

    // Resolve manualLocation to proper state/district for waterfall
    if (manualLocation && manualLocation !== 'All') {
      const loc = await Location.findOne({ name: manualLocation });
      if (loc) {
        if (loc.locationType === 'district') {
          district = loc.name;
          state = loc.parentName; // e.g., 'Telangana'
        } else if (loc.locationType === 'state') {
          state = loc.name;
          district = null;
        } else {
          // Fallback if not state or district
          district = null;
          state = null;
        }
      }
    }

    const baseQuery = { isActive: { $ne: false } };
    Object.assign(baseQuery, buildNewsLanguageFilter(lang));
    if (category && category !== 'All') {
      const resolvedCategory = await resolveCategoryFilter(category);
      if (resolvedCategory) baseQuery.category = resolvedCategory;
    }

    // 1. Define Neighboring State for waterfall
    let neighborState = null;
    if (state === 'Andhra Pradesh') neighborState = 'Telangana';
    else if (state === 'Telangana') neighborState = 'Andhra Pradesh';

    const cutoff72h = new Date(Date.now() - 72 * 60 * 60 * 1000);

    // 2. Define Segments for Waterfall
    const segments = [];
    
    // Tier 1: District news (last 72 hours)
    if (district) {
      segments.push({ ...baseQuery, location: district, publishedAt: { $gte: cutoff72h } });
    }
    // Tier 2: State news
    if (state) {
      segments.push({ ...baseQuery, location: state });
    }
    // Tier 3: Neighboring State news
    if (neighborState) {
      segments.push({ ...baseQuery, location: neighborState });
    }
    // Tier 4: National news
    segments.push({ ...baseQuery, $or: [{ scope: 'national' }, { location: 'National' }] });
    // Tier 5: International news
    segments.push({ ...baseQuery, $or: [{ scope: 'international' }, { location: 'International' }] });

    // 3. Get counts for all segments
    const counts = await Promise.all(segments.map(q => News.countDocuments(q)));

    // 4. Handle Empty District logic
    let showEmptyMessage = false;
    if (pageNum === 1 && district) {
       // Since district was provided, it's the first segment
       const districtCount = counts[0];
       if (districtCount === 0) {
         showEmptyMessage = true;
       }
    }

    // 5. Waterfall Fetch across segments
    const offset = (pageNum - 1) * limit;
    let currentOffset = offset;
    let needed = limit;
    const feed = [];

    for (let i = 0; i < segments.length && needed > 0; i++) {
      if (currentOffset < counts[i]) {
        const fetchCount = Math.min(counts[i] - currentOffset, needed);
        const items = await News.find(segments[i])
          .sort({ publishedAt: -1 })
          .skip(currentOffset)
          .limit(fetchCount)
          .lean();

        feed.push(...items);
        needed -= items.length;
        currentOffset = 0; // For subsequent segments, start skip from 0
      } else {
        // Skip this segment entirely
        currentOffset -= counts[i];
      }
    }

    const paged = feed;

    // Transform for Flutter (same format as existing endpoint)
    const transformed = paged.map(news => ({
      id: news._id,
      title: news.title,
      content: news.content,
      imageUrl: news.mediaUrl || news.imageUrl,
      imageUrls: news.imageUrls || [],
      videoUrl: news.videoUrl,
      mediaUrl: news.mediaUrl || news.imageUrl,
      mediaType: news.mediaType || 'image',
      thumbnailUrl: news.thumbnailUrl || news.mediaUrl || news.imageUrl,
      category: news.category,
      location: news.location,
      scope: news.scope || 'state',
      language: news.language || 'te',
      publishedAt: news.publishedAt,
      likes: news.likes || 0,
      dislikes: news.dislikes || 0,
      views: news.views || 0,
      comments: news.comments || 0,
      author: news.author,
      authorId: news.authorId,
      authorProfileImage: news.authorProfileImage,
      authorConstituency: news.authorConstituency,
      readFullLink: news.readFullLink,
      ePaperLink: news.ePaperLink,
      shortId: news.shortId,
    }));

    res.json({
      news: transformed,
      showEmptyDistrictMessage: showEmptyMessage,
      fallbackState: showEmptyMessage ? state : null,
      meta: {
        page: pageNum,
        limit,
        total: counts.reduce((a, b) => a + b, 0),
      },
    });
  } catch (error) {
    console.error('Error fetching smart feed:', error);
    res.status(500).json({ error: 'Error fetching smart feed' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Save user location profile (called from Flutter after location permission)
// ──────────────────────────────────────────────────────────────────────────────
router.post('/api/public/user/location', verifyMobileUser, async (req, res) => {
  try {
    const { primaryState, primaryDistrict, lat, lng, source, additionalLocations } = req.body;
    const userId = req.user?.userId || req.user?._id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const update = {
      'locationProfile.primaryState': primaryState || null,
      'locationProfile.primaryDistrict': primaryDistrict || null,
      'locationProfile.coordinates.lat': lat || null,
      'locationProfile.coordinates.lng': lng || null,
      'locationProfile.source': source || 'manual',
      'locationProfile.updatedAt': new Date(),
    };

    if (additionalLocations) {
      update['locationProfile.additionalLocations'] = additionalLocations;
    }

    await User.findByIdAndUpdate(userId, { $set: update });
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving user location:', error);
    res.status(500).json({ error: 'Error saving user location' });
  }
});

// Public API endpoint for fetching active ads (no authentication required)
// Cached for 5 minutes (300 seconds)
router.get('/api/public/ads', cacheMiddleware(300), async (req, res) => {
  try {
    // Check if MongoDB is connected
    const isConnectedToMongoDB = mongoose.connection.readyState === 1;

    if (isConnectedToMongoDB) {
      const { lang } = req.query;
      const { buildPublicAdQuery, syncScheduledAds } = require('../services/adScheduleService');
      const now = new Date();
      await syncScheduledAds();

      const ads = await Ad.find(buildPublicAdQuery(now, lang)).sort({ createdAt: -1 });

      // Transform data for Flutter app
      const transformedAds = ads.map(ad => {
        const adObj = ad.toObject ? ad.toObject() : ad;
        return {
          id: adObj._id,
          title: adObj.title,
          content: adObj.content,
          imageUrl: adObj.imageUrl || (adObj.imageUrls && adObj.imageUrls.length > 0 ? adObj.imageUrls[0] : '/images/placeholder.png'),
          imageUrls: adObj.imageUrls || (adObj.imageUrl ? [adObj.imageUrl] : []),
          linkUrl: adObj.linkUrl,
          positionInterval: adObj.positionInterval || 3,
          // Intelligent ad fields
          maxViewsPerDay: adObj.maxViewsPerDay || 3,
          cooldownPeriodHours: adObj.cooldownPeriodHours || 24,
          frequencyControlEnabled: adObj.frequencyControlEnabled !== undefined ? adObj.frequencyControlEnabled : true,
          userBehaviorTrackingEnabled: adObj.userBehaviorTrackingEnabled !== undefined ? adObj.userBehaviorTrackingEnabled : true,
          // AdMob fields
          useAdMob: adObj.useAdMob || false,
          adMobAppId: adObj.adMobAppId,
          adMobUnitId: adObj.adMobUnitId,
          createdAt: adObj.createdAt
        };
      });

      res.json(transformedAds);
    } else {
      const { filterAdsForPublic } = require('../services/adScheduleService');
      const adsData = req.app.locals.adsData || [];
      const activeAds = filterAdsForPublic(adsData, new Date(), req.query.lang || null)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      // Transform data for Flutter app
      const transformedAds = activeAds.map(ad => {
        return {
          id: ad._id,
          title: ad.title,
          content: ad.content,
          imageUrl: ad.imageUrl || (ad.imageUrls && ad.imageUrls.length > 0 ? ad.imageUrls[0] : '/images/placeholder.png'),
          imageUrls: ad.imageUrls || (ad.imageUrl ? [ad.imageUrl] : []),
          linkUrl: ad.linkUrl,
          positionInterval: ad.positionInterval || 3,
          // Intelligent ad fields
          maxViewsPerDay: ad.maxViewsPerDay || 3,
          cooldownPeriodHours: ad.cooldownPeriodHours || 24,
          frequencyControlEnabled: ad.frequencyControlEnabled !== undefined ? ad.frequencyControlEnabled : true,
          userBehaviorTrackingEnabled: ad.userBehaviorTrackingEnabled !== undefined ? ad.userBehaviorTrackingEnabled : true,
          // AdMob fields
          useAdMob: ad.useAdMob || false,
          adMobAppId: ad.adMobAppId,
          adMobUnitId: ad.adMobUnitId,
          createdAt: ad.createdAt
        };
      });

      res.json(transformedAds);
    }
  } catch (error) {
    console.error('Error fetching public ads:', error);
    res.status(500).json({ error: 'Error fetching ads' });
  }
});

// Public API endpoint for fetching viral videos (no authentication required)
// Cached for 5 minutes (300 seconds)
router.get('/api/public/viral-videos', cacheMiddleware(300), async (req, res) => {
  try {
    let videosList;

    // Check if MongoDB is connected
    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;

    if (isConnectedToMongoDB) {
      // Fetch only active viral videos from MongoDB
      const query = { isActive: true };
      if (req.query.language) {
        query.language = req.query.language;
      }
      videosList = await ViralVideo.find(query).sort({ publishedAt: -1 }).limit(FEED_MAX);
    } else {
      // Use in-memory storage (if available) or empty list
      // For now returning empty list if no DB, could add mock data in server.js later
      videosList = [];
    }

    // Transform data for Flutter app
    const transformedVideos = videosList.map(video => {
      const videoObj = video.toObject ? video.toObject() : video;
      return {
        id: videoObj._id,
        title: videoObj.title,
        content: videoObj.content,
        videoUrl: videoObj.videoUrl,
        mediaUrl: videoObj.mediaUrl, // Uploaded video
        thumbnailUrl: videoObj.thumbnailUrl || '/images/placeholder.png',
        category: videoObj.category, // It has category
        language: videoObj.language || 'te',
        location: 'Viral', // Viral videos might not have location, defaulting
        publishedAt: videoObj.publishedAt,
        views: videoObj.views || 0,
        likes: videoObj.likes || 0,
        dislikes: videoObj.dislikes || 0,
        comments: videoObj.comments || 0,
        author: videoObj.author,
        // Include user interaction details
        userLikes: stripEmails(videoObj.userInteractions?.likes),
        userDislikes: stripEmails(videoObj.userInteractions?.dislikes),
        userComments: videoObj.userInteractions?.comments || []
      };
    });

    res.json(transformedVideos);
  } catch (error) {
    console.error('Error fetching public viral videos:', error);
    res.status(500).json({ error: 'Error fetching viral videos' });
  }
});

// Public API endpoint for fetching long videos (no authentication required)
// Cached for 5 minutes (300 seconds)
router.get('/api/public/long-videos', cacheMiddleware(300), async (req, res) => {
  try {
    let videosList;

    // Check if MongoDB is connected
    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;

    if (isConnectedToMongoDB) {
      const LongVideo = require('../models/LongVideo');
      // Fetch only active long videos from MongoDB
      videosList = await LongVideo.find({ isActive: true }).sort({ publishedAt: -1 });
    } else {
      videosList = [];
    }

    // Transform data for Flutter app
    const transformedVideos = videosList.map(video => {
      const videoObj = video.toObject ? video.toObject() : video;
      return {
        id: videoObj._id,
        title: videoObj.title,
        description: videoObj.description,
        videoUrl: videoObj.videoUrl,
        thumbnailUrl: videoObj.thumbnailUrl || '/images/placeholder.png',
        category: videoObj.category,
        publishedAt: videoObj.publishedAt,
        views: videoObj.views || 0,
        likes: videoObj.likes || 0
      };
    });

    res.json(transformedVideos);
  } catch (error) {
    console.error('Error fetching public long videos:', error);
    res.status(500).json({ error: 'Error fetching long videos' });
  }
});


// New endpoint for viral video interactions
router.post('/api/public/viral-videos/:id/interact', async (req, res) => {
  try {
    const { id } = req.params;
    const { action, userId, userName, userEmail, commentText } = req.body;

    console.log(`🎬 Viral video interaction: ${action} by ${userName} (${userId})`);

    // Simple user validation - no complex token verification
    if (!userId || !userName) {
      return res.status(400).json({ error: 'User information required' });
    }

    if (!['like', 'dislike', 'comment', 'unlike', 'undislike'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    const isConnectedToMongoDB = mongoose.connection.readyState === 1;
    if (isConnectedToMongoDB) {
      const video = await ViralVideo.findById(id);
      if (!video) return res.status(404).json({ error: 'Video not found' });

      // Initialize userInteractions if needed
      if (!video.userInteractions) {
        video.userInteractions = { likes: [], dislikes: [], comments: [] };
      }

      // Helper for array manipulation
      const removeFrom = (arr, uid) => {
        const idx = arr.findIndex(i => i.userId === uid);
        if (idx !== -1) arr.splice(idx, 1);
        return idx !== -1;
      };

      const userInfo = { userId, userName, userEmail: userEmail || '' };

      switch (action) {
        case 'like':
          // Remove dislike if exists
          if (removeFrom(video.userInteractions.dislikes, userInfo.userId)) {
            video.dislikes = Math.max(0, video.dislikes - 1);
          }
          // Add like if not exists
          if (!video.userInteractions.likes.find(i => i.userId === userInfo.userId)) {
            video.userInteractions.likes.push({
              userId: userInfo.userId,
              userName: userInfo.userName,
              userEmail: userInfo.userEmail
            });
            video.likes++;
          }
          break;
        case 'dislike':
          // Remove like if exists
          if (removeFrom(video.userInteractions.likes, userInfo.userId)) {
            video.likes = Math.max(0, video.likes - 1);
          }
          // Add dislike if not exists
          if (!video.userInteractions.dislikes.find(i => i.userId === userInfo.userId)) {
            video.userInteractions.dislikes.push({
              userId: userInfo.userId,
              userName: userInfo.userName,
              userEmail: userInfo.userEmail
            });
            video.dislikes++;
          }
          break;
        case 'unlike':
          if (removeFrom(video.userInteractions.likes, userInfo.userId)) {
            video.likes = Math.max(0, video.likes - 1);
          }
          break;
        case 'undislike':
          if (removeFrom(video.userInteractions.dislikes, userInfo.userId)) {
            video.dislikes = Math.max(0, video.dislikes - 1);
          }
          break;
        case 'comment':
          if (!commentText) return res.status(400).json({ error: 'Comment required' });
          video.userInteractions.comments.push({
            userId: userInfo.userId,
            userName: userInfo.userName,
            userEmail: userInfo.userEmail,
            comment: commentText,
            timestamp: new Date()
          });
          video.comments++;
          break;
        case 'delete_comment':
          if (commentText === undefined || commentText === null) return res.status(400).json({ error: 'Comment text required' });
          // Remove user's own comment
          const initialLength = video.userInteractions.comments.length;
          video.userInteractions.comments = video.userInteractions.comments.filter(
            c => !(c.comment === commentText && c.userId === userInfo.userId)
          );
          if (video.userInteractions.comments.length < initialLength) {
            video.comments = Math.max(0, video.comments - 1);
            console.log(`🗑️ Comment deleted: "${commentText.substring(0, 30)}..."`);
          }
          break;
        case 'like_comment':
          if (!commentText) return res.status(400).json({ error: 'Comment text required' });
          // Find the comment
          const comment = video.userInteractions.comments.find(c => c.comment === commentText);
          if (comment) {
            if (!comment.likes) comment.likes = [];
            const likeIndex = comment.likes.findIndex(like => like.userId === userInfo.userId);
            if (likeIndex === -1) {
              // Add like
              comment.likes.push({
                userId: userInfo.userId,
                userName: userInfo.userName,
                timestamp: new Date()
              });
              console.log(`❤️ Comment liked by ${userInfo.userName}`);
            } else {
              // Remove like
              comment.likes.splice(likeIndex, 1);
              console.log(`💔 Comment unliked by ${userInfo.userName}`);
            }
          }
          break;
      }

      await video.save();

      // Return updated video object (transformed to match GET endpoint format)
      const videoObj = video.toObject();
      res.json({
        id: videoObj._id,
        title: videoObj.title,
        content: videoObj.content,
        videoUrl: videoObj.videoUrl,
        mediaUrl: videoObj.mediaUrl,
        thumbnailUrl: videoObj.thumbnailUrl || '/images/placeholder.png',
        category: videoObj.category,
        location: 'Viral',
        publishedAt: videoObj.publishedAt,
        views: videoObj.views || 0,
        likes: videoObj.likes,
        dislikes: videoObj.dislikes,
        comments: videoObj.comments,
        author: videoObj.author,
        userLikes: stripEmails(videoObj.userInteractions?.likes),
        userDislikes: stripEmails(videoObj.userInteractions?.dislikes),
        userComments: videoObj.userInteractions?.comments || []
      });

    } else {
      res.status(500).json({ error: 'Database not connected' });
    }

  } catch (error) {
    console.error('Error in viral video interaction:', error);
    res.status(500).json({ error: 'Error processing interaction' });
  }
});

// Viral Video Comment Report endpoint
router.post('/api/public/viral-videos/comments/report', async (req, res) => {
  try {
    const { videoId, commentText, commentUserId, commentUserName, userId, userName, userEmail, reason, additionalDetails } = req.body;

    console.log(`🚨 Viral video comment report: "${commentText?.substring(0, 50)}..." by ${userName}`);

    // Validate required fields
    if (!videoId || !commentText || !userId || !reason) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: videoId, commentText, userId, reason'
      });
    }

    // Validate reason
    const validReasons = ['biased', 'abusive', 'hateful', 'fake', 'spam', 'others'];
    if (!validReasons.includes(reason)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid reason. Must be one of: ' + validReasons.join(', ')
      });
    }

    // Check if MongoDB is connected
    const isConnectedToMongoDB = mongoose.connection.readyState === 1;

    if (isConnectedToMongoDB) {
      // Create viral video comment report (reuse CommentReport model)
      const commentReport = new CommentReport({
        newsId: videoId, // Reusing newsId field for videoId
        commentText,
        commentUserId: commentUserId || 'unknown',
        commentUserName: commentUserName || 'Unknown User',
        reportedBy: {
          userId,
          userName: userName || 'Anonymous',
          userEmail: userEmail || ''
        },
        reason,
        additionalDetails: additionalDetails || '',
        status: 'pending'
      });

      await commentReport.save();

      console.log(`✅ Viral video comment reported: Reason=${reason}`);

      // Emit WebSocket event to admin dashboard
      const io = req.app.locals.io || req.app.get('io');
      if (io) {
        io.emit('new_comment_report', {
          reportId: commentReport._id,
          newsId: videoId,
          commentText,
          commentUserName,
          reportedBy: userName,
          reason,
          timestamp: commentReport.createdAt,
          isViralVideo: true
        });
      }

      res.status(201).json({
        success: true,
        message: 'Viral video comment reported successfully',
        reportId: commentReport._id
      });
    } else {
      console.log(`🗂️ In-memory mode: Viral video comment report logged`);
      res.status(201).json({
        success: true,
        message: 'Viral video comment reported successfully (in-memory mode)'
      });
    }
  } catch (error) {
    console.error('Error reporting viral video comment:', error);
    res.status(500).json({
      success: false,
      message: 'Error submitting comment report',
      error: error.message
    });
  }
});

// Public API endpoint for ad interactions (no authentication required)
router.post('/api/public/ads/:id/interaction', async (req, res) => {
  try {
    const { id } = req.params;
    const { adTitle, interactionType, viewDurationSeconds } = req.body;

    // Check if MongoDB is connected
    const isConnectedToMongoDB = mongoose.connection.readyState === 1;

    if (isConnectedToMongoDB) {
      // Import AdAnalytics model
      const AdAnalytics = require('../models/AdAnalytics');

      // Find or create analytics record for this ad
      let adAnalytics = await AdAnalytics.findOne({ adId: id });

      if (!adAnalytics) {
        adAnalytics = new AdAnalytics({
          adId: id,
          adTitle: adTitle || 'Unknown Ad'
        });
      }

      // Update analytics based on interaction type
      if (interactionType === 'view') {
        adAnalytics.impressions += 1;
        adAnalytics.uniqueViews += 1; // Simplified - in reality, we'd track unique users

        if (viewDurationSeconds) {
          // Update average view duration (simplified calculation)
          const totalViewTime = (adAnalytics.avgViewDurationSeconds * (adAnalytics.impressions - 1)) + viewDurationSeconds;
          adAnalytics.avgViewDurationSeconds = totalViewTime / adAnalytics.impressions;
        }
      } else if (interactionType === 'click') {
        adAnalytics.clicks += 1;
      }

      // Update CTR
      adAnalytics.ctr = adAnalytics.impressions > 0 ? (adAnalytics.clicks / adAnalytics.impressions) * 100 : 0;

      // Update timestamps
      adAnalytics.updatedAt = new Date();

      // Save the analytics data
      await adAnalytics.save();

      res.json({ message: 'Ad interaction recorded successfully' });
    } else {
      // For in-memory mode, just log the interaction
      console.log(`Ad interaction recorded - ID: ${id}, Type: ${interactionType}, Duration: ${viewDurationSeconds}`);
      res.json({ message: 'Ad interaction recorded successfully (in-memory mode)' });
    }
  } catch (error) {
    console.error('Error recording ad interaction:', error);
    res.status(500).json({ error: 'Error recording ad interaction' });
  }
});

// Public API endpoint for reporting news (no authentication required for now)
router.post('/api/public/news/:id/report', async (req, res) => {
  try {
    const { id } = req.params;
    const mongoose = require('mongoose');

    let { reason, description, userId, userEmail, userName, mobileNumber } = req.body;

    // Validate input
    if (!reason) {
      return res.status(400).json({
        success: false,
        message: 'Reason is required'
      });
    }

    // Check if MongoDB is connected
    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;

    if (isConnectedToMongoDB) {
      // Check if news exists
      const news = await News.findById(id);
      if (!news) {
        return res.status(404).json({
          success: false,
          message: 'News not found'
        });
      }

      // If we have a userId, try to get the most current user information
      if (userId && userId !== 'anonymous') {
        try {
          // Check if userId is a valid MongoDB ObjectId before querying
          if (mongoose.Types.ObjectId.isValid(userId)) {
            const User = require('../models/User');
            const user = await User.findById(userId);

            if (user) {
              // Update user information with the most current data from the database
              userName = user.displayName;
              // For mobile users, use the mobileNumber field; for others, use email
              userEmail = user.mobileNumber || user.email;
              // Also get mobile number if available
              mobileNumber = user.mobileNumber || mobileNumber;
            }
          } else {
            console.log(`Report submitted with non-ObjectId userId: ${userId}`);
          }
        } catch (userError) {
          console.error('Error fetching user data:', userError);
          // Continue with provided data if user lookup fails
        }
      }

      // Create report
      const report = new Report({
        newsId: id,
        userId: userId || 'anonymous',
        userEmail: userEmail || '',
        userName: userName || 'Anonymous',
        reason,
        description,
        mobileNumber // Store mobile number explicitly
      });

      await report.save();

      // Emit WebSocket event to admin dashboard
      const io = req.app.locals.io || req.app.get('io');
      if (io) {
        io.emit('new_news_report', {
          reportId: report._id,
          newsId: id, // Pass just the ID or if you want title you need to fetch it or pass from news object
          reportedBy: userName,
          reason,
          timestamp: report.createdAt
        });
        console.log('📡 WebSocket notification sent for news report');
      }

      res.status(201).json({
        success: true,
        message: 'Report submitted successfully',
        report
      });
    } else {
      // For in-memory storage, we'll just log the report
      console.log(`Report submitted for news ${id}: ${reason}`);
      res.status(201).json({
        success: true,
        message: 'Report submitted successfully (in-memory mode)'
      });
    }
  } catch (error) {
    console.error('Error submitting report:', error);
    res.status(500).json({
      success: false,
      message: 'Error submitting report',
      error: error.message
    });
  }
});

// Comment Report endpoint
router.post('/api/public/comments/report', async (req, res) => {
  try {
    const { newsId, commentText, commentUserId, commentUserName, userId, userName, userEmail, reason, additionalDetails } = req.body;

    // Validate required fields
    if (!newsId || !commentText || !userId || !reason) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: newsId, commentText, userId, reason'
      });
    }

    // Validate reason
    const validReasons = ['biased', 'abusive', 'hateful', 'fake', 'spam', 'others'];
    if (!validReasons.includes(reason)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid reason. Must be one of: ' + validReasons.join(', ')
      });
    }

    // Check if MongoDB is connected
    const isConnectedToMongoDB = mongoose.connection.readyState === 1;

    if (isConnectedToMongoDB) {
      // Create comment report
      const commentReport = new CommentReport({
        newsId,
        commentText,
        commentUserId: commentUserId || 'unknown',
        commentUserName: commentUserName || 'Unknown User',
        reportedBy: {
          userId,
          userName: userName || 'Anonymous',
          userEmail: userEmail || ''
        },
        reason,
        additionalDetails: additionalDetails || '',
        status: 'pending'
      });

      await commentReport.save();

      console.log(`🚨 Comment reported: "${commentText.substring(0, 50)}..." by ${userName} (Reason: ${reason})`);

      // Emit WebSocket event to admin dashboard
      const io = req.app.locals.io || req.app.get('io');
      if (io) {
        io.emit('new_comment_report', {
          reportId: commentReport._id,
          newsId,
          commentText,
          commentUserName,
          reportedBy: userName,
          reason,
          timestamp: commentReport.createdAt
        });
        console.log('📡 WebSocket notification sent to admin dashboard');
      }

      res.status(201).json({
        success: true,
        message: 'Comment reported successfully',
        reportId: commentReport._id
      });
    } else {
      // In-memory mode - just log
      console.log(`🚨 Comment report (in-memory): "${commentText}" - Reason: ${reason}`);
      res.status(201).json({
        success: true,
        message: 'Comment reported successfully (in-memory mode)'
      });
    }
  } catch (error) {
    console.error('Error submitting comment report:', error);
    res.status(500).json({
      success: false,
      message: 'Error submitting comment report',
      error: error.message
    });
  }
});


// New endpoint for admin to get detailed user interaction analytics
router.get('/api/admin/news/:id/analytics', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if MongoDB is connected
    const isConnectedToMongoDB = mongoose.connection.readyState === 1;

    if (isConnectedToMongoDB) {
      const news = await News.findById(id);
      if (!news) {
        return res.status(404).json({ error: 'News not found' });
      }

      // Get detailed analytics data
      const analytics = {
        newsId: news._id,
        title: news.title,
        totalLikes: news.likes || 0,
        totalDislikes: news.dislikes || 0,
        totalComments: news.comments || 0,
        userInteractions: {
          likes: news.userInteractions?.likes || [],
          dislikes: news.userInteractions?.dislikes || [],
          comments: news.userInteractions?.comments || []
        },
        summary: {
          uniqueUsers: new Set([
            ...(news.userInteractions?.likes?.map(l => l.userId) || []),
            ...(news.userInteractions?.dislikes?.map(d => d.userId) || []),
            ...(news.userInteractions?.comments?.map(c => c.userId) || [])
          ]).size,
          mostActiveUsers: _getMostActiveUsers(news.userInteractions)
        }
      };

      res.json(analytics);
    } else {
      res.status(503).json({ error: 'Database not available' });
    }
  } catch (error) {
    console.error('Error fetching news analytics:', error);
    res.status(500).json({ error: 'Error fetching analytics' });
  }
});

// Test endpoint to verify user interaction exclusivity
router.get('/api/test/user-interactions/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    // Check if MongoDB is connected
    const isConnectedToMongoDB = mongoose.connection.readyState === 1;

    if (isConnectedToMongoDB) {
      // Find all news where user has interacted
      const newsWithLikes = await News.find({
        'userInteractions.likes.userId': userId
      }).select('title userInteractions');

      const newsWithDislikes = await News.find({
        'userInteractions.dislikes.userId': userId
      }).select('title userInteractions');

      const newsWithComments = await News.find({
        'userInteractions.comments.userId': userId
      }).select('title userInteractions');

      // Check for conflicts (user has both liked and disliked same news)
      const likedNewsIds = newsWithLikes.map(n => n._id.toString());
      const dislikedNewsIds = newsWithDislikes.map(n => n._id.toString());
      const conflicts = likedNewsIds.filter(id => dislikedNewsIds.includes(id));

      res.json({
        userId,
        summary: {
          totalLikes: newsWithLikes.length,
          totalDislikes: newsWithDislikes.length,
          totalComments: newsWithComments.length,
          conflicts: conflicts.length,
          conflictedNews: conflicts
        },
        interactions: {
          liked: newsWithLikes.map(n => ({
            newsId: n._id,
            title: n.title,
            likedAt: n.userInteractions.likes.find(l => l.userId === userId)?.timestamp
          })),
          disliked: newsWithDislikes.map(n => ({
            newsId: n._id,
            title: n.title,
            dislikedAt: n.userInteractions.dislikes.find(d => d.userId === userId)?.timestamp
          })),
          commented: newsWithComments.map(n => ({
            newsId: n._id,
            title: n.title,
            comments: n.userInteractions.comments.filter(c => c.userId === userId)
          }))
        }
      });
    } else {
      res.status(503).json({ error: 'Database not available' });
    }
  } catch (error) {
    console.error('Error fetching user interactions:', error);
    res.status(500).json({ error: 'Error fetching user interactions' });
  }
});

// Helper function to get most active users
function _getMostActiveUsers(userInteractions) {
  const userActivity = {};

  if (userInteractions) {
    // Count likes
    (userInteractions.likes || []).forEach(like => {
      if (!userActivity[like.userId]) {
        userActivity[like.userId] = { userName: like.userName, likes: 0, dislikes: 0, comments: 0 };
      }
      userActivity[like.userId].likes++;
    });

    // Count dislikes
    (userInteractions.dislikes || []).forEach(dislike => {
      if (!userActivity[dislike.userId]) {
        userActivity[dislike.userId] = { userName: dislike.userName, likes: 0, dislikes: 0, comments: 0 };
      }
      userActivity[dislike.userId].dislikes++;
    });

    // Count comments
    (userInteractions.comments || []).forEach(comment => {
      if (!userActivity[comment.userId]) {
        userActivity[comment.userId] = { userName: comment.userName, likes: 0, dislikes: 0, comments: 0 };
      }
      userActivity[comment.userId].comments++;
    });
  }

  // Convert to array and sort by total activity
  return Object.entries(userActivity)
    .map(([userId, activity]) => ({
      userId,
      ...activity,
      totalActivity: activity.likes + activity.dislikes + activity.comments
    }))
    .sort((a, b) => b.totalActivity - a.totalActivity)
    .slice(0, 10); // Top 10 most active users
}

// Public endpoint for uploading profile images (no session auth required)
// This is used by the Next.js reporters app for profile image uploads
router.post('/api/public/upload-profile-image', uploadMedia.single('media'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileUrl = req.file.path;

    console.log('Profile image uploaded successfully:', fileUrl);

    return res.json({
      url: fileUrl,
      success: true,
      message: 'Profile image uploaded successfully'
    });
  } catch (error) {
    console.error('Profile image upload error:', error);
    res.status(500).json({ error: 'Error uploading profile image: ' + error.message });
  }
});

// Generic endpoint for registration file uploads (Docs, PDFs, etc.)
router.post('/api/public/upload-registration-file', uploadRegistrationMedia.single('media'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileUrl = req.file.path;
    console.log('Registration file uploaded to R2:', fileUrl);

    return res.json({
      url: fileUrl,
      success: true,
      message: 'File uploaded successfully'
    });
  } catch (error) {
    console.error('Registration file upload error:', error);
    res.status(500).json({ error: 'Error uploading file: ' + error.message });
  }
});

// --- URL Shortener Endpoints ---
const ShortLink = require('../models/ShortLink');
const AppSettings = require('../models/AppSettings');

// 1. Generate a short link for a given newsId
router.post('/api/public/shorten', async (req, res) => {
  try {
    const { newsId } = req.body;
    if (!newsId) {
      return res.status(400).json({ error: 'newsId is required' });
    }

    // Check if a short link already exists for this newsId
    let shortLink = await ShortLink.findOne({ newsId });

    if (!shortLink) {
      // Create a new one
      shortLink = new ShortLink({ newsId });
      await shortLink.save();
    }

    // In the future, this domain could be ynews.in or anynews.link
    // For now we use the current host dynamically or fallback to www.news.cbnyellowsingam.in
    const host = req.get('host') || 'www.news.cbnyellowsingam.in';
    const protocol = req.protocol === 'https' || host.includes('cbnyellowsingam') ? 'https' : 'http';

    // We construct the short link URL.
    const shortUrl = `${protocol}://${host}/${shortLink.shortCode}`;

    return res.json({
      success: true,
      shortCode: shortLink.shortCode,
      shortUrl: shortUrl,
      newsId: newsId
    });
  } catch (error) {
    console.error('Error generating short link:', error);
    res.status(500).json({ error: 'Server error generating short link' });
  }
});

// 1.5 Expand a short code back into a newsId for the mobile app
router.get('/api/public/expand/:shortCode', async (req, res) => {
  try {
    const { shortCode } = req.params;
    const shortLink = await ShortLink.findOne({ shortCode });
    if (!shortLink) {
      return res.status(404).json({ error: 'Short link not found' });
    }
    return res.json({
      success: true,
      newsId: shortLink.newsId
    });
  } catch (error) {
    console.error('Error expanding short link:', error);
    res.status(500).json({ error: 'Server error expanding short link' });
  }
});

// 2. Handle hitting the short link — Smart Redirect (Firebase Dynamic Links style)
// Matches exactly 6 alphanumeric characters to prevent conflicting with other routes like /admin
router.get('/:shortCode([a-zA-Z0-9]{6})', async (req, res, next) => {
  try {
    const { shortCode } = req.params;
    const shortLink = await ShortLink.findOne({ shortCode });

    if (!shortLink) {
      return next(); // Pass to next middleware/404 if not a valid short code
    }

    // Increment clicks asynchronously
    shortLink.clicks += 1;
    shortLink.save().catch(err => console.error('Error updating clicks:', err));

    const host = req.get('host') || 'news.tehelkanews.in';
    const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';

    const newsId = shortLink.newsId;
    const appPackage = 'com.lavish.yellowsingam';
    const settings = await AppSettings.findOne({ key: 'update_flags' });
    const playStoreUrl = settings?.androidUpdateUrl || `https://play.google.com/store/apps/details?id=${appPackage}`;
    const appStoreUrl = settings?.iosUpdateUrl || 'https://apps.apple.com/app/tehelka-news-daily-news-app/id6772203356';
    const logoUrl = `${protocol}://${host}/images/logo.png`;
    const playStoreBadgeUrl = `${protocol}://${host}/images/google-play-badge.png`;
    const appStoreBadgeUrl = `${protocol}://${host}/images/app-store-badge.png`;
    const deepLinkUrl = `${protocol}://${host}/news/${newsId}`;
    const intentUrl = `intent://${host}/news/${newsId}#Intent;scheme=https;package=${appPackage};S.browser_fallback_url=${encodeURIComponent(playStoreUrl)};end`;

    // Smart redirect page: open app if installed, otherwise show Tehelka News + store links
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tehelka News - Opening...</title>
  <meta property="og:title" content="Tehelka News" />
  <meta property="og:description" content="Read this news on Tehelka News app" />
  <meta property="og:url" content="${deepLinkUrl}" />
  <meta property="og:image" content="${logoUrl}" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(180deg, #0a0a0a 0%, #1a1a1a 100%);
      color: #fff;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      text-align: center;
    }
    .container { padding: 2rem; max-width: 420px; width: 100%; }
    .logo {
      width: 100%;
      max-width: 240px;
      height: auto;
      margin: 0 auto 1rem;
      display: block;
      object-fit: contain;
      border-radius: 0;
      box-shadow: none;
    }
    h1 {
      font-size: 1.75rem;
      margin-bottom: 0.35rem;
      color: #FF5A36;
      font-weight: 800;
      letter-spacing: -0.02em;
    }
    .tagline { font-size: 0.95rem; color: #aaa; margin-bottom: 1.5rem; }
    .spinner {
      width: 36px; height: 36px; margin: 0 auto 1rem;
      border: 3px solid rgba(255, 90, 54, 0.2);
      border-top-color: #FF5A36;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .status-text { font-size: 0.9rem; color: #888; margin-bottom: 1.5rem; }
    .store-section { margin-top: 0.5rem; }
    .store-label {
      font-size: 0.85rem;
      color: #999;
      margin-bottom: 1rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .store-buttons {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.85rem;
    }
    .store-badge-link {
      display: inline-block;
      line-height: 0;
      transition: transform 0.15s, opacity 0.15s;
    }
    .store-badge-link--play {
      border-radius: 12px;
      overflow: hidden;
      border: 2px solid rgba(255, 255, 255, 0.55);
      box-sizing: border-box;
    }
    .store-badge-link--play .store-badge {
      border-radius: 12px;
    }
    .store-badge-link:hover {
      transform: translateY(-1px);
      opacity: 0.92;
    }
    .store-badge {
      height: 52px;
      width: auto;
      max-width: 100%;
      display: block;
    }
    .hidden { display: none; }
    @media (min-width: 640px) {
      .container { max-width: 560px; }
      .logo { max-width: 220px; }
      .store-buttons {
        flex-direction: row;
        justify-content: center;
        align-items: stretch;
        gap: 1rem;
      }
      .store-badge-link { flex: 1; max-width: 240px; }
      .store-badge {
        height: 72px;
        width: 100%;
        object-fit: contain;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <img src="${logoUrl}" alt="Tehelka News" class="logo"
         onerror="this.src='/images/placeholder.png'" />
    <h1>Tehelka News</h1>
    <p class="tagline">National & worldwide news, instant updates</p>

    <div id="loading">
      <div class="spinner"></div>
      <p class="status-text">Opening in app...</p>
    </div>

    <div id="store-section" class="store-section">
      <p class="store-label">Download Tehelka News app</p>
      <div class="store-buttons">
        <a href="${playStoreUrl}" class="store-badge-link store-badge-link--play" id="play-store-btn" target="_blank" rel="noopener noreferrer">
          <img src="${playStoreBadgeUrl}" alt="Get it on Google Play" class="store-badge" />
        </a>
        <a href="${appStoreUrl}" class="store-badge-link" id="app-store-btn" target="_blank" rel="noopener noreferrer">
          <img src="${appStoreBadgeUrl}" alt="Download on the App Store" class="store-badge" />
        </a>
      </div>
    </div>
  </div>

  <script>
    (function() {
      var userAgent = navigator.userAgent || '';
      var isAndroid = /android/i.test(userAgent);
      var isIOS = /ipad|iphone|ipod/i.test(userAgent);
      var deepLink = '${deepLinkUrl}';
      var appStoreUrl = '${appStoreUrl}';

      if (isAndroid) {
        window.location.href = '${intentUrl}';
        setTimeout(function() {
          document.getElementById('loading').classList.add('hidden');
        }, 2500);
      } else if (isIOS) {
        window.location.href = deepLink;
        setTimeout(function() {
          window.location.href = appStoreUrl;
        }, 1500);
        setTimeout(function() {
          document.getElementById('loading').classList.add('hidden');
        }, 2500);
      } else {
        document.getElementById('loading').classList.add('hidden');
      }
    })();
  </script>
</body>
</html>
    `);
  } catch (error) {
    console.error('Error handling short link:', error);
    res.status(500).send('Internal Server Error');
  }
});

// --- Zodiac Calendar Public API Routes ---
router.get('/api/zodiac/today', zodiacController.getZodiacToday);
router.post('/api/zodiac/:id/like', zodiacController.likeZodiac);
router.post('/api/zodiac/:id/dislike', zodiacController.dislikeZodiac);
router.post('/api/zodiac/:id/comment', zodiacController.commentZodiac);
router.get('/api/zodiac/:id/comments', zodiacController.getZodiacComments);

module.exports = router;