const ViralVideo = require('../models/ViralVideo');
const { deleteFromR2 } = require('../config/cloudflare');

// Get all viral videos
exports.getAllViralVideos = async (req, res) => {
    try {
        const videos = await ViralVideo.find()
            .sort({ publishedAt: -1 });
        console.log(`Found ${videos.length} viral videos`);
        res.json({ videos });
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
