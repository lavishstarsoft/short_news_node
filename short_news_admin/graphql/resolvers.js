const News = require('../models/News');
const Category = require('../models/Category');
const Location = require('../models/Location');
const User = require('../models/User');
const ViralVideo = require('../models/ViralVideo');

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
            // Return userInteractions.comments array with comment text
            if (parent.userInteractions && parent.userInteractions.comments) {
                return parent.userInteractions.comments.map(comment => ({
                    userId: comment.userId,
                    userName: comment.userName,
                    userEmail: comment.userEmail || '',
                    comment: comment.comment,
                    timestamp: comment.timestamp ? comment.timestamp.toISOString() : new Date().toISOString(),
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

        // Viral video mutations
        likeViralVideo: async (_, { videoId }) => {
            try {
                const video = await ViralVideo.findById(videoId);
                if (!video) {
                    throw new Error('Viral video not found');
                }

                video.likes += 1;
                await video.save();

                return video;
            } catch (error) {
                console.error('Error liking viral video:', error);
                throw new Error('Failed to like viral video');
            }
        },

        dislikeViralVideo: async (_, { videoId }) => {
            try {
                const video = await ViralVideo.findById(videoId);
                if (!video) {
                    throw new Error('Viral video not found');
                }

                video.dislikes += 1;
                await video.save();

                return video;
            } catch (error) {
                console.error('Error disliking viral video:', error);
                throw new Error('Failed to dislike viral video');
            }
        },
    },
};

module.exports = resolvers;
