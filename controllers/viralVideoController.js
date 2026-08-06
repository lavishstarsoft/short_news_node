const ViralVideo = require('../models/ViralVideo');
const { deleteFromR2 } = require('../config/cloudflare');

// Get all viral videos (paginated)
exports.getAllViralVideos = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(48, Math.max(6, parseInt(req.query.limit, 10) || 12));
        const skip = (page - 1) * limit;
        const search = (req.query.search || '').trim();
        const status = ['active', 'inactive'].includes(req.query.status) ? req.query.status : '';
        const category = (req.query.category || '').trim();

        const query = {};
        if (req.admin && req.admin.role === 'subeditor') {
            query.authorId = req.admin.id;
        }
        if (search) {
            query.$or = [
                { title: { $regex: search, $options: 'i' } },
                { content: { $regex: search, $options: 'i' } },
                { author: { $regex: search, $options: 'i' } },
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
            ViralVideo.countDocuments(query),
            ViralVideo.find(query)
                .sort({ publishedAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            ViralVideo.aggregate([
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
            ViralVideo.distinct('category')
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

        console.log(`Found ${videos.length} viral videos (page ${safePage}/${totalPages})`);

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
        console.error('Error fetching viral videos:', error);
        res.status(500).json({ error: 'Error fetching viral videos' });
    }
};

// Create new viral video
exports.createViralVideo = async (req, res) => {
    try {
        const videoData = {
            ...req.body,
            author: req.admin.username,
            authorId: req.admin.id,
            publishedAt: new Date()
        };

        const video = new ViralVideo(videoData);
        await video.save();
        console.log('Viral Video created:', video._id);

        res.status(201).json(video);
    } catch (error) {
        console.error('Error creating viral video:', error);
        res.status(400).json({ error: 'Error creating viral video: ' + error.message });
    }
};

// Update viral video
exports.updateViralVideo = async (req, res) => {
    try {
        const existingVideo = await ViralVideo.findById(req.params.id);
        if (existingVideo && req.body.videoUrl && req.body.videoUrl !== existingVideo.videoUrl) {
            await deleteFromR2(existingVideo.videoUrl);
            if (existingVideo.thumbnailUrl && existingVideo.thumbnailUrl !== existingVideo.videoUrl) {
                await deleteFromR2(existingVideo.thumbnailUrl);
            }
        }

        const video = await ViralVideo.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true }
        );

        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        res.json(video);
    } catch (error) {
        console.error('Error updating viral video:', error);
        res.status(400).json({ error: 'Error updating viral video' });
    }
};

// Delete viral video
exports.deleteViralVideo = async (req, res) => {
    try {
        if (req.admin && req.admin.role === 'subeditor') {
            return res.status(403).json({ error: 'Sub-editors are not allowed to delete viral videos. You can only hide them.' });
        }
        const video = await ViralVideo.findByIdAndDelete(req.params.id);

        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        // Delete from Cloudflare R2
        if (video.videoUrl) {
            await deleteFromR2(video.videoUrl);
            if (video.thumbnailUrl && video.thumbnailUrl !== video.videoUrl) {
                await deleteFromR2(video.thumbnailUrl);
            }
        }

        res.json({ message: 'Video deleted successfully' });
    } catch (error) {
        console.error('Error deleting viral video:', error);
        res.status(500).json({ error: 'Error deleting viral video' });
    }
};

// Toggle video active status
exports.toggleVideoStatus = async (req, res) => {
    try {
        const video = await ViralVideo.findById(req.params.id);

        if (!video) {
            return res.status(404).json({ error: 'Video not found' });
        }

        video.isActive = !video.isActive;
        await video.save();

        res.json(video);
    } catch (error) {
        console.error('Error toggling video status:', error);
        res.status(500).json({ error: 'Error toggling video status' });
    }
};
