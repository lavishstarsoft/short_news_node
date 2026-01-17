const News = require('../models/News');
const ViralVideo = require('../models/ViralVideo');
const Category = require('../models/Category');
const Location = require('../models/Location');
const Ad = require('../models/Ad');
const User = require('../models/User');

const resolvers = {
    Query: {
        // News queries
        news: async (_, { limit = 50, offset = 0, category, location }) => {
            try {
                let query = { isActive: true };

                if (category) {
                    query.category = category;
                }

                if (location) {
                    query.location = location;
                }

                const news = await News.find(query)
                    .sort({ publishedAt: -1 })
                    .skip(offset)
                    .limit(limit);

                return news;
            } catch (error) {
                console.error('Error fetching news:', error);
                throw new Error('Failed to fetch news');
            }
        },

        newsById: async (_, { id }) => {
            try {
                const news = await News.findById(id);
                return news;
            } catch (error) {
                console.error('Error fetching news by ID:', error);
                throw new Error('Failed to fetch news');
            }
        },

        // Category queries
        categories: async () => {
            try {
                const categories = await Category.find();
                return categories;
            } catch (error) {
                console.error('Error fetching categories:', error);
                throw new Error('Failed to fetch categories');
            }
        },

        categoryById: async (_, { id }) => {
            try {
                const category = await Category.findById(id);
                return category;
            } catch (error) {
                console.error('Error fetching category by ID:', error);
                throw new Error('Failed to fetch category');
            }
        },

        // Location queries
        locations: async () => {
            try {
                const locations = await Location.find();
                return locations;
            } catch (error) {
                console.error('Error fetching locations:', error);
                throw new Error('Failed to fetch locations');
            }
        },

        locationById: async (_, { id }) => {
            try {
                const location = await Location.findById(id);
                return location;
            } catch (error) {
                console.error('Error fetching location by ID:', error);
                throw new Error('Failed to fetch location');
            }
        },

        // User queries
        user: async (_, { id }) => {
            try {
                const user = await User.findById(id);
                return user;
            } catch (error) {
                console.error('Error fetching user:', error);
                throw new Error('Failed to fetch user');
            }
        },

        // Viral videos queries
        viralVideos: async (_, { limit = 50, offset = 0 }) => {
            try {
                const videos = await ViralVideo.find()
                    .sort({ createdAt: -1 })
                    .skip(offset)
                    .limit(limit);

                return videos;
            } catch (error) {
                console.error('Error fetching viral videos:', error);
                throw new Error('Failed to fetch viral videos');
            }
        },

        viralVideoById: async (_, { id }) => {
            try {
                const video = await ViralVideo.findById(id);
                return video;
            } catch (error) {
                console.error('Error fetching viral video by ID:', error);
                throw new Error('Failed to fetch viral video');
            }
        },
    },

    // Field resolvers for News type
    News: {
        commentsData: (parent) => {
            // Convert userInteractions.comments to Comment type
            if (parent.userInteractions && parent.userInteractions.comments) {
                return parent.userInteractions.comments.map(comment => ({
                    id: comment._id ? comment._id.toString() : new Date().getTime().toString(),
                    text: comment.comment,
                    userId: comment.userId,
                    userName: comment.userName,
                    createdAt: comment.timestamp ? comment.timestamp.toISOString() : new Date().toISOString(),
                }));
            }
            return [];
        },
        userLikes: (parent) => {
            // Return userInteractions.likes array
            if (parent.userInteractions && parent.userInteractions.likes) {
                return parent.userInteractions.likes.map(like => ({
                    userId: like.userId,
                    userName: like.userName,
                    userEmail: like.userEmail || '',
                    timestamp: like.timestamp ? like.timestamp.toISOString() : new Date().toISOString(),
                }));
            }
            return [];
        },
        userDislikes: (parent) => {
            // Return userInteractions.dislikes array
            if (parent.userInteractions && parent.userInteractions.dislikes) {
                return parent.userInteractions.dislikes.map(dislike => ({
                    userId: dislike.userId,
                    userName: dislike.userName,
                    userEmail: dislike.userEmail || '',
                    timestamp: dislike.timestamp ? dislike.timestamp.toISOString() : new Date().toISOString(),
                }));
            }
            return [];
        },
        userComments: (parent) => {
            // Return userInteractions.comments array with comment text and likes
            if (parent.userInteractions && parent.userInteractions.comments) {
                return parent.userInteractions.comments.map(comment => ({
                    userId: comment.userId,
                    userName: comment.userName,
                    userEmail: comment.userEmail || '',
                    comment: comment.comment,
                    timestamp: comment.timestamp ? comment.timestamp.toISOString() : new Date().toISOString(),
                    likes: (comment.likes || []).map(like => ({
                        userId: like.userId,
                        userName: like.userName,
                        timestamp: like.timestamp ? like.timestamp.toISOString() : new Date().toISOString(),
                    })),
                }));
            }
            return [];
        },
        userViews: (parent) => {
            // Return userInteractions.views array for view tracking
            if (parent.userInteractions && parent.userInteractions.views) {
                return parent.userInteractions.views.map(view => ({
                    userId: view.userId,
                    userName: view.userName,
                    userEmail: view.userEmail || '',
                    timestamp: view.timestamp ? view.timestamp.toISOString() : new Date().toISOString(),
                }));
            }
            return [];
        },
    },

    Mutation: {
        // News mutations
        likeNews: async (_, { newsId }) => {
            try {
                const news = await News.findById(newsId);
                if (!news) {
                    throw new Error('News not found');
                }

                news.likes += 1;
                await news.save();

                return news;
            } catch (error) {
                console.error('Error liking news:', error);
                throw new Error('Failed to like news');
            }
        },

        dislikeNews: async (_, { newsId }) => {
            try {
                const news = await News.findById(newsId);
                if (!news) {
                    throw new Error('News not found');
                }

                news.dislikes += 1;
                await news.save();

                return news;
            } catch (error) {
                console.error('Error disliking news:', error);
                throw new Error('Failed to dislike news');
            }
        },

        addComment: async (_, { newsId, text }) => {
            try {
                const news = await News.findById(newsId);
                if (!news) {
                    throw new Error('News not found');
                }

                // Initialize userInteractions if it doesn't exist
                if (!news.userInteractions) {
                    news.userInteractions = { likes: [], dislikes: [], comments: [] };
                }

                const comment = {
                    userId: 'anonymous', // You can update this with actual user ID from context
                    userName: 'Anonymous User',
                    userEmail: '',
                    comment: text,
                    timestamp: new Date(),
                };

                news.userInteractions.comments.push(comment);
                news.comments = (news.comments || 0) + 1; // Increment comment count
                await news.save();

                return news;
            } catch (error) {
                console.error('Error adding comment:', error);
                throw new Error('Failed to add comment');
            }
        },

        incrementViews: async (_, { newsId, userId, userName }) => {
            try {
                const news = await News.findById(newsId);
                if (!news) {
                    throw new Error('News not found');
                }

                // Check if user already viewed this news
                const alreadyViewed = news.userInteractions.views.some(
                    view => view.userId === userId
                );

                if (!alreadyViewed) {
                    // Increment total views
                    news.views += 1;

                    // Add to userViews array for tracking
                    news.userInteractions.views.push({
                        userId: userId,
                        userName: userName || 'Anonymous',
                        timestamp: new Date()
                    });

                    await news.save();
                    console.log(`✅ View tracked: ${news.title.substring(0, 40)}... - User: ${userId} - Total views: ${news.views}`);
                } else {
                    console.log(`ℹ️ Duplicate view prevented: ${news.title.substring(0, 40)}... - User: ${userId}`);
                }

                return news;
            } catch (error) {
                console.error('Error incrementing views:', error);
                throw new Error('Failed to increment views');
            }
        },

        // New user interaction mutations (matching REST API functionality)
        interactWithNews: async (_, { newsId, action, userId, userName, userEmail, commentText }) => {
            try {
                const news = await News.findById(newsId);
                if (!news) {
                    throw new Error('News not found');
                }

                // Initialize userInteractions if it doesn't exist
                if (!news.userInteractions) {
                    news.userInteractions = { likes: [], dislikes: [], comments: [], views: [] };
                }

                switch (action) {
                    case 'like':
                        // Check if user already disliked
                        const existingDislikeIndex = news.userInteractions.dislikes.findIndex(
                            dislike => dislike.userId === userId
                        );
                        if (existingDislikeIndex !== -1) {
                            news.dislikes = Math.max(0, news.dislikes - 1);
                            news.userInteractions.dislikes.splice(existingDislikeIndex, 1);
                        }

                        // Toggle like
                        const existingLikeIndex = news.userInteractions.likes.findIndex(
                            like => like.userId === userId
                        );
                        if (existingLikeIndex === -1) {
                            news.likes += 1;
                            news.userInteractions.likes.push({
                                userId,
                                userName: userName || 'User',
                                userEmail: userEmail || '',
                                timestamp: new Date()
                            });
                        } else {
                            news.likes = Math.max(0, news.likes - 1);
                            news.userInteractions.likes.splice(existingLikeIndex, 1);
                        }
                        break;

                    case 'dislike':
                        // Check if user already liked
                        const existingLikeIndex2 = news.userInteractions.likes.findIndex(
                            like => like.userId === userId
                        );
                        if (existingLikeIndex2 !== -1) {
                            news.likes = Math.max(0, news.likes - 1);
                            news.userInteractions.likes.splice(existingLikeIndex2, 1);
                        }

                        // Toggle dislike
                        const existingDislikeIndex2 = news.userInteractions.dislikes.findIndex(
                            dislike => dislike.userId === userId
                        );
                        if (existingDislikeIndex2 === -1) {
                            news.dislikes += 1;
                            news.userInteractions.dislikes.push({
                                userId,
                                userName: userName || 'User',
                                userEmail: userEmail || '',
                                timestamp: new Date()
                            });
                        } else {
                            news.dislikes = Math.max(0, news.dislikes - 1);
                            news.userInteractions.dislikes.splice(existingDislikeIndex2, 1);
                        }
                        break;

                    case 'comment':
                        if (!commentText) {
                            throw new Error('Comment text is required');
                        }
                        news.comments += 1;
                        news.userInteractions.comments.push({
                            userId,
                            userName: userName || 'User',
                            userEmail: userEmail || '',
                            comment: commentText,
                            timestamp: new Date(),
                            likes: []
                        });
                        break;

                    case 'delete_comment':
                        if (!commentText) {
                            throw new Error('Comment text is required for deletion');
                        }
                        const commentIndex = news.userInteractions.comments.findIndex(
                            c => String(c.userId) === String(userId) && c.comment === commentText
                        );
                        if (commentIndex !== -1) {
                            news.userInteractions.comments.splice(commentIndex, 1);
                            news.comments = Math.max(0, news.comments - 1);
                        }
                        break;

                    case 'like_comment':
                        if (!commentText) {
                            throw new Error('Comment text is required to like');
                        }
                        const comment = news.userInteractions.comments.find(
                            c => c.comment === commentText
                        );
                        if (comment) {
                            if (!comment.likes) {
                                comment.likes = [];
                            }
                            const likeIndex = comment.likes.findIndex(
                                like => String(like.userId) === String(userId)
                            );
                            if (likeIndex === -1) {
                                comment.likes.push({
                                    userId,
                                    userName: userName || 'User',
                                    timestamp: new Date()
                                });
                            } else {
                                comment.likes.splice(likeIndex, 1);
                            }
                            news.markModified('userInteractions.comments');
                        } else {
                            throw new Error('Comment not found to like');
                        }
                        break;

                    default:
                        throw new Error(`Invalid action: ${action}`);
                }

                await news.save();
                console.log(`✅ GraphQL: ${action} by ${userName} on news ${newsId}`);
                return news;
            } catch (error) {
                console.error('Error in interactWithNews:', error);
                throw error;
            }
        },

        interactWithViralVideo: async (_, { videoId, action, userId, userName, userEmail, commentText }) => {
            try {
                console.log(`🎬 GraphQL: Viral video interaction: ${action} by ${userName} (${userId})`);

                const video = await ViralVideo.findById(videoId);
                if (!video) throw new Error('Video not found');

                const userInfo = { userId, userName, userEmail };
                const removeFrom = (arr, uid) => {
                    const idx = arr.findIndex(i => i.userId === uid);
                    if (idx !== -1) arr.splice(idx, 1);
                    return idx !== -1;
                };

                if (!video.userInteractions) {
                    video.userInteractions = { likes: [], dislikes: [], comments: [] };
                }

                switch (action) {
                    case 'like':
                        // Remove from dislikes if exists (mutual exclusivity)
                        if (removeFrom(video.userInteractions.dislikes, userId)) {
                            video.dislikes = Math.max(0, video.dislikes - 1);
                            console.log(`   Removed dislike from user ${userId}`);
                        }

                        // Toggle like (Instagram-style)
                        const existingLike = video.userInteractions.likes.find(i => i.userId === userId);
                        if (!existingLike) {
                            // Add like
                            video.userInteractions.likes.push({
                                ...userInfo,
                                timestamp: new Date()
                            });
                            video.likes++;
                            console.log(`   ❤️ Added like from ${userName}`);
                        } else {
                            // Remove like (unlike)
                            removeFrom(video.userInteractions.likes, userId);
                            video.likes = Math.max(0, video.likes - 1);
                            console.log(`   💔 Removed like from ${userName}`);
                        }
                        break;

                    case 'dislike':
                        // Remove from likes if exists (mutual exclusivity)
                        if (removeFrom(video.userInteractions.likes, userId)) {
                            video.likes = Math.max(0, video.likes - 1);
                            console.log(`   Removed like from user ${userId}`);
                        }

                        // Toggle dislike (Instagram-style)
                        const existingDislike = video.userInteractions.dislikes.find(i => i.userId === userId);
                        if (!existingDislike) {
                            // Add dislike
                            video.userInteractions.dislikes.push({
                                ...userInfo,
                                timestamp: new Date()
                            });
                            video.dislikes++;
                            console.log(`   👎 Added dislike from ${userName}`);
                        } else {
                            // Remove dislike (undislike)
                            removeFrom(video.userInteractions.dislikes, userId);
                            video.dislikes = Math.max(0, video.dislikes - 1);
                            console.log(`   Removed dislike from ${userName}`);
                        }
                        break;
                    case 'comment':
                        if (!commentText) throw new Error('Comment text required');

                        // Ensure comments array exists
                        if (!video.userInteractions.comments) {
                            console.log('⚠️ Initializing missing comments array');
                            video.userInteractions.comments = [];
                        }

                        console.log(`\n📝 === ADDING COMMENT ===`);
                        console.log(`   Video ID: ${videoId}`);
                        console.log(`   User: ${userName} (${userId})`);
                        console.log(`   Comment Text: "${commentText}"`);
                        console.log(`   Comments before: ${video.userInteractions.comments.length}`);
                        console.log(`   Comment count before: ${video.comments}`);

                        video.userInteractions.comments.push({
                            ...userInfo,
                            comment: commentText,
                            timestamp: new Date(),
                            likes: [] // Initialize likes array for comment likes
                        });
                        video.comments++;

                        console.log(`   Comments after: ${video.userInteractions.comments.length}`);
                        console.log(`   Comment count after: ${video.comments}`);
                        console.log(`   Last comment: ${JSON.stringify(video.userInteractions.comments[video.userInteractions.comments.length - 1])}`);
                        break;
                }

                // CRITICAL: Force Mongoose to detect changes in nested arrays!
                if (action === 'like' || action === 'dislike' || action === 'unlike' || action === 'undislike') {
                    video.markModified('userInteractions.likes');
                    video.markModified('userInteractions.dislikes');
                } else if (action === 'comment') {
                    video.markModified('userInteractions.comments');
                    console.log(`   🔧 Marked comments as modified`);
                }

                console.log(`   💾 Saving to database...`);
                await video.save();
                console.log(`   ✅ Save successful!`);
                console.log(`   📊 Final state - Comments: ${video.userInteractions.comments.length}, Count: ${video.comments}`);

                // Debug: Log what we're returning to Flutter
                console.log(`   🔍 Returning video object:`);
                console.log(`      - ID: ${video._id}`);
                console.log(`      - Title: ${video.title}`);
                console.log(`      - createdAt: ${video.createdAt}`);
                console.log(`      - publishedAt: ${video.publishedAt}`);
                console.log(`      - Likes: ${video.likes}, Dislikes: ${video.dislikes}`);
                console.log(`      - userLikes: ${video.userInteractions.likes.length}`);
                console.log(`      - userDislikes: ${video.userInteractions.dislikes.length}\n`);

                return video;
            } catch (error) {
                console.error('Error in interactWithViralVideo:', error);
                throw error;
            }
        },

        // Like/Unlike a viral video comment
        likeViralVideoComment: async (_, { videoId, commentText, userId, userName }) => {
            try {
                console.log(`❤️ GraphQL: Like viral video comment by ${userName}`);

                const video = await ViralVideo.findById(videoId);
                if (!video) throw new Error('Video not found');

                if (!video.userInteractions) {
                    video.userInteractions = { likes: [], dislikes: [], comments: [] };
                }

                // Find the comment
                const comment = video.userInteractions.comments.find(c => c.comment === commentText);
                if (!comment) throw new Error('Comment not found');

                // Initialize likes array if not exists
                if (!comment.likes) comment.likes = [];

                // Toggle like
                const likeIndex = comment.likes.findIndex(like => like.userId === userId);
                if (likeIndex === -1) {
                    // Add like
                    comment.likes.push({
                        userId,
                        userName,
                        timestamp: new Date()
                    });
                    console.log(`✅ Like added to comment`);
                } else {
                    // Remove like
                    comment.likes.splice(likeIndex, 1);
                    console.log(`✅ Like removed from comment`);
                }

                // CRITICAL: Force Mongoose to detect changes/moves in nested array!
                video.markModified('userInteractions.comments');
                await video.save();
                return video;
            } catch (error) {
                console.error('Error liking viral video comment:', error);
                throw error;
            }
        },

        // Delete own viral video comment
        deleteViralVideoComment: async (_, { videoId, commentId, commentText, userId, timestamp }) => {
            try {
                console.log(`\n🗑️ START DELETE: User ${userId} wants to delete comment`);
                if (commentId) console.log(`   Target ID: ${commentId}`);
                if (commentText) console.log(`   Target Text: "${commentText}"`);

                const video = await ViralVideo.findById(videoId);
                if (!video) {
                    console.log('❌ Video not found');
                    throw new Error('Video not found');
                }

                if (!video.userInteractions?.comments) {
                    console.log('❌ No comments in video');
                    throw new Error('No comments found');
                }

                const initialLength = video.userInteractions.comments.length;
                console.log(`📊 Initial comments count: ${initialLength}`);

                let deletedParams = null; // Store for logging what matched

                // Filter out the comment
                video.userInteractions.comments = video.userInteractions.comments.filter(comment => {
                    // Normalize IDs to strings for comparison
                    const commentUserId = String(comment.userId);
                    const reqUserId = String(userId);

                    if (commentUserId !== reqUserId) {
                        return true; // Keep others' comments
                    }

                    // 1. ID Match (Highest Priority)
                    if (commentId && comment._id) {
                        if (String(comment._id) === String(commentId)) {
                            console.log(`✅ MATCHED by ID!`);
                            deletedParams = { type: 'id', id: commentId };
                            return false; // Remove
                        }
                    }

                    // 2. Timestamp Match (Secondary)
                    if (timestamp && comment.timestamp) {
                        const dbTime = new Date(comment.timestamp).getTime();
                        const reqTime = new Date(timestamp).getTime();
                        const timeDiff = Math.abs(dbTime - reqTime);

                        if (timeDiff < 5000) { // 5s tolerance
                            console.log(`✅ MATCHED by timestamp! (${timeDiff}ms diff)`);
                            deletedParams = { type: 'timestamp', diff: timeDiff, text: comment.comment };
                            return false; // Remove
                        }
                    }

                    // 3. Text Match (Fallback)
                    if (commentText) {
                        const dbComment = (comment.comment || '').trim();
                        const reqComment = (commentText || '').trim();

                        if (dbComment === reqComment) {
                            console.log(`✅ MATCHED by text content!`);
                            deletedParams = { type: 'text', text: dbComment };
                            return false; // Remove
                        }
                    }

                    return true; // Keep
                });

                if (video.userInteractions.comments.length === initialLength) {
                    console.log('⚠️ Failed to find matching comment to delete');
                    throw new Error('Comment not found or unauthorized');
                }

                // Decrement comment count
                video.comments = Math.max(0, video.comments - 1);

                // CRITICAL: Force Mongoose to detect the change in nested array!
                video.markModified('userInteractions.comments');
                await video.save();

                console.log(`✅ SUCCESS: Deleted comment via ${deletedParams?.type}. Remaining: ${video.userInteractions.comments.length}\n`);
                return video;
            } catch (error) {
                console.error('❌ Error deleting viral video comment:', error);
                throw error;
            }
        },

        likeComment: async (_, { newsId, commentId, userId, userName, userEmail }) => {
            try {
                const news = await News.findById(newsId);
                if (!news) throw new Error('News not found');

                const comment = news.userInteractions.comments.id(commentId);
                if (!comment) throw new Error('Comment not found');

                if (!comment.likes) comment.likes = [];

                const existingLike = comment.likes.find(like => like.userId === userId);
                if (!existingLike) {
                    comment.likes.push({ userId, userName, userEmail });
                }

                await news.save();
                return news;
            } catch (error) {
                console.error('Error in likeComment:', error);
                throw error;
            }
        },

        deleteComment: async (_, { newsId, commentId, userId }) => {
            try {
                const news = await News.findById(newsId);
                if (!news) throw new Error('News not found');

                const comment = news.userInteractions.comments.id(commentId);
                if (!comment) throw new Error('Comment not found');

                if (comment.userId !== userId) {
                    throw new Error('Unauthorized');
                }

                comment.remove();
                news.comments = Math.max(0, news.comments - 1);

                await news.save();
                return news;
            } catch (error) {
                console.error('Error in deleteComment:', error);
                throw error;
            }
        },
    },

    ViralVideo: {
        createdAt: (parent) => {
            // Provide default timestamp if missing
            if (parent.createdAt) {
                return parent.createdAt.toISOString ? parent.createdAt.toISOString() : parent.createdAt;
            }
            // Fallback to publishedAt or current time
            if (parent.publishedAt) {
                return parent.publishedAt.toISOString ? parent.publishedAt.toISOString() : parent.publishedAt;
            }
            return new Date().toISOString();
        },
        userLikes: (parent) => {
            return (parent.userInteractions?.likes || []).map(like => ({
                userId: like.userId,
                userName: like.userName,
                userEmail: like.userEmail || '',
                timestamp: like.timestamp ? (like.timestamp.toISOString ? like.timestamp.toISOString() : new Date(like.timestamp).toISOString()) : new Date().toISOString()
            }));
        },
        userDislikes: (parent) => {
            return (parent.userInteractions?.dislikes || []).map(dislike => ({
                userId: dislike.userId,
                userName: dislike.userName,
                userEmail: dislike.userEmail || '',
                timestamp: dislike.timestamp ? (dislike.timestamp.toISOString ? dislike.timestamp.toISOString() : new Date(dislike.timestamp).toISOString()) : new Date().toISOString()
            }));
        },
        userComments: (parent) => {
            return (parent.userInteractions?.comments || []).map(comment => ({
                id: comment._id ? comment._id.toString() : null,
                userId: comment.userId,
                userName: comment.userName,
                userEmail: comment.userEmail || '',
                comment: comment.comment,
                timestamp: comment.timestamp ? (comment.timestamp.toISOString ? comment.timestamp.toISOString() : new Date(comment.timestamp).toISOString()) : new Date().toISOString(),
                likes: (comment.likes || []).map(like => ({
                    userId: like.userId,
                    userName: like.userName,
                    timestamp: like.timestamp ? (like.timestamp.toISOString ? like.timestamp.toISOString() : new Date(like.timestamp).toISOString()) : new Date().toISOString()
                }))
            }));
        },
    },
};

module.exports = resolvers;
