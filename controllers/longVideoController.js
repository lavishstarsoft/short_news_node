const LongVideo = require('../models/LongVideo');

exports.getAllLongVideos = async (req, res) => {
    try {
        const videos = await LongVideo.find().sort({ publishedAt: -1 });
        res.json(videos);
    } catch (error) {
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
        res.status(500).json({ error: 'Failed to create long video' });
    }
};

exports.updateLongVideo = async (req, res) => {
    try {
        const { id } = req.params;
        const updatedVideo = await LongVideo.findByIdAndUpdate(id, req.body, { new: true });
        res.json(updatedVideo);
    } catch (error) {
        res.status(500).json({ error: 'Failed to update long video' });
    }
};

exports.deleteLongVideo = async (req, res) => {
    try {
        await LongVideo.findByIdAndDelete(req.params.id);
        res.json({ message: 'Video deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete video' });
    }
};

exports.toggleVideoStatus = async (req, res) => {
    try {
        const video = await LongVideo.findById(req.params.id);
        video.isActive = !video.isActive;
        await video.save();
        res.json(video);
    } catch (error) {
        res.status(500).json({ error: 'Failed to toggle status' });
    }
};
