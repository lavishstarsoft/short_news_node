const LongVideo = require('../models/LongVideo');

exports.getAllLongVideos = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(48, Math.max(6, parseInt(req.query.limit, 10) || 12));
        const skip = (page - 1) * limit;
        const search = (req.query.search || '').trim();
        const status = ['active', 'inactive'].includes(req.query.status) ? req.query.status : '';
        const category = (req.query.category || '').trim();

        const query = {};
        if (search) {
            query.$or = [
                { title: { $regex: search, $options: 'i' } },
                { description: { $regex: search, $options: 'i' } },
                { category: { $regex: search, $options: 'i' } }
            ];
        }
        if (status === 'active') {
            query.isActive = true;
        } else if (status === 'inactive') {
            query.isActive = false;
        }
        if (category) {
            query.category = category;
        }

        const [totalFiltered, videos, globalStatsAgg, categories] = await Promise.all([
            LongVideo.countDocuments(query),
            LongVideo.find(query)
                .sort({ publishedAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            LongVideo.aggregate([
                {
                    $group: {
                        _id: null,
                        total: { $sum: 1 },
                        active: { $sum: { $cond: ['$isActive', 1, 0] } },
                        inactive: { $sum: { $cond: [{ $eq: ['$isActive', false] }, 1, 0] } },
                        totalViews: { $sum: { $ifNull: ['$views', 0] } },
                        totalLikes: { $sum: { $ifNull: ['$likes', 0] } }
                    }
                }
            ]),
            LongVideo.distinct('category')
        ]);

        const globalStats = globalStatsAgg[0] || {
            total: 0,
            active: 0,
            inactive: 0,
            totalViews: 0,
            totalLikes: 0
        };

        const totalPages = Math.max(1, Math.ceil(totalFiltered / limit));
        const safePage = Math.min(page, totalPages);

        res.json({
            videos,
            categories: categories.filter(Boolean).sort(),
            stats: {
                total: globalStats.total,
                active: globalStats.active,
                inactive: globalStats.inactive,
                totalViews: globalStats.totalViews,
                totalLikes: globalStats.totalLikes
            },
            pagination: {
                currentPage: safePage,
                limit,
                totalVideos: totalFiltered,
                totalPages
            }
        });
    } catch (error) {
        console.error('Error fetching long videos:', error);
        res.status(500).json({ error: 'Failed to fetch long videos' });
    }
};

exports.createLongVideo = async (req, res) => {
    try {
        const { title, description, videoUrl, thumbnailUrl, category } = req.body;
        const newVideo = new LongVideo({
            title,
            description,
            videoUrl,
            thumbnailUrl,
            category
        });
        await newVideo.save();
        res.status(201).json(newVideo);
    } catch (error) {
        console.error('Error creating long video:', error);
        res.status(500).json({ error: 'Failed to create long video' });
    }
};

exports.updateLongVideo = async (req, res) => {
    try {
        const { id } = req.params;
        const updatedVideo = await LongVideo.findByIdAndUpdate(id, req.body, { new: true });
        if (!updatedVideo) {
            return res.status(404).json({ error: 'Video not found' });
        }
        res.json(updatedVideo);
    } catch (error) {
        console.error('Error updating long video:', error);
        res.status(500).json({ error: 'Failed to update long video' });
    }
};

exports.deleteLongVideo = async (req, res) => {
    try {
        const deleted = await LongVideo.findByIdAndDelete(req.params.id);
        if (!deleted) {
            return res.status(404).json({ error: 'Video not found' });
        }
        res.json({ message: 'Video deleted successfully' });
    } catch (error) {
        console.error('Error deleting long video:', error);
        res.status(500).json({ error: 'Failed to delete video' });
    }
};

exports.toggleVideoStatus = async (req, res) => {
    try {
        const video = await LongVideo.findById(req.params.id);
        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }
        video.isActive = !video.isActive;
        await video.save();
        res.json(video);
    } catch (error) {
        console.error('Error toggling long video status:', error);
        res.status(500).json({ error: 'Failed to toggle status' });
    }
};
