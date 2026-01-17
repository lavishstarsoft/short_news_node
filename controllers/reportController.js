const Report = require('../models/Report');
const News = require('../models/News');

// Create a new report
exports.createReport = async (req, res) => {
  try {
    const { newsId, reason, description, mobileNumber } = req.body;
    const userId = req.user?.googleId || req.body.userId;
    const userEmail = req.user?.email || req.body.userEmail;
    const userName = req.user?.displayName || req.body.userName;

    // Validate input
    if (!newsId || !reason) {
      return res.status(400).json({
        success: false,
        message: 'News ID and reason are required'
      });
    }

    // Check if news exists
    const news = await News.findById(newsId);
    if (!news) {
      return res.status(404).json({
        success: false,
        message: 'News not found'
      });
    }

    // Create report
    const report = new Report({
      newsId,
      userId,
      userEmail: mobileNumber || userEmail, // Use mobileNumber if available, otherwise use userEmail
      userName,
      reason,
      description,
      mobileNumber // Store mobile number explicitly
    });

    await report.save();

    res.status(201).json({
      success: true,
      message: 'Report submitted successfully',
      report
    });
  } catch (error) {
    console.error('Error creating report:', error);
    res.status(500).json({
      success: false,
      message: 'Error submitting report',
      error: error.message
    });
  }
};

// Get all reports (admin only)
exports.getAllReports = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const contentType = req.query.contentType; // 'news', 'viral_video', or undefined for all

    // Build query based on contentType
    const query = contentType ? { contentType } : {};

    // First get reports with conditional population
    let reports = await Report.find(query)
      .populate('newsId', 'title content')
      .populate('viralVideoId', 'title content category')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    // Then populate user information for each report
    const User = require('../models/User');
    const mongoose = require('mongoose');

    reports = await Promise.all(reports.map(async (report) => {
      // Try to find user by userId (which is the user's _id for mobile users)
      let user = null;
      if (report.userId && mongoose.Types.ObjectId.isValid(report.userId)) {
        user = await User.findById(report.userId);
      }

      // If not found by _id, try to find by mobileNumber
      if (!user && report.mobileNumber) {
        user = await User.findOne({ mobileNumber: report.mobileNumber });
      }

      // If still not found, try to find by email (for Google users)
      if (!user && report.userEmail && !report.userEmail.includes('@mobile.user')) {
        user = await User.findOne({ email: report.userEmail });
      }

      // If user found, update report with actual user data
      if (user) {
        report.userName = user.displayName;
        // For mobile users, use the mobileNumber field; for others, use email
        report.userEmail = user.mobileNumber || user.email;
        // Also populate mobileNumber if available
        if (user.mobileNumber) {
          report.mobileNumber = user.mobileNumber;
        }
      }

      return report;
    }));

    const total = await Report.countDocuments(query);

    res.json({
      success: true,
      reports,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching reports:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching reports',
      error: error.message
    });
  }
};

// Get reports by status
exports.getReportsByStatus = async (req, res) => {
  try {
    const { status } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // First get reports with news populated
    let reports = await Report.find({ status })
      .populate('newsId', 'title content')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    // Then populate user information for each report
    const User = require('../models/User');
    const mongoose = require('mongoose');

    reports = await Promise.all(reports.map(async (report) => {
      // Try to find user by userId (which is the user's _id for mobile users)
      let user = null;
      if (report.userId && mongoose.Types.ObjectId.isValid(report.userId)) {
        user = await User.findById(report.userId);
      }

      // If not found by _id, try to find by mobileNumber
      if (!user && report.mobileNumber) {
        user = await User.findOne({ mobileNumber: report.mobileNumber });
      }

      // If still not found, try to find by email (for Google users)
      if (!user && report.userEmail && !report.userEmail.includes('@mobile.user')) {
        user = await User.findOne({ email: report.userEmail });
      }

      // If user found, update report with actual user data
      if (user) {
        report.userName = user.displayName;
        // For mobile users, use the mobileNumber field; for others, use email
        report.userEmail = user.mobileNumber || user.email;
        // Also populate mobileNumber if available
        if (user.mobileNumber) {
          report.mobileNumber = user.mobileNumber;
        }
      }

      return report;
    }));

    const total = await Report.countDocuments({ status });

    res.json({
      success: true,
      reports,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching reports by status:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching reports',
      error: error.message
    });
  }
};

// Update report status (admin only)
exports.updateReportStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    // Validate status
    if (!['pending', 'reviewed', 'resolved', 'dismissed'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status'
      });
    }

    const report = await Report.findById(id);
    if (!report) {
      return res.status(404).json({
        success: false,
        message: 'Report not found'
      });
    }

    report.status = status;
    report.reviewedAt = new Date();
    report.reviewedBy = req.admin?.id || req.body.reviewedBy;

    await report.save();

    res.json({
      success: true,
      message: 'Report status updated successfully',
      report
    });
  } catch (error) {
    console.error('Error updating report status:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating report status',
      error: error.message
    });
  }
};

// Delete report (admin only)
exports.deleteReport = async (req, res) => {
  try {
    const { id } = req.params;

    const report = await Report.findByIdAndDelete(id);
    if (!report) {
      return res.status(404).json({
        success: false,
        message: 'Report not found'
      });
    }

    res.json({
      success: true,
      message: 'Report deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting report:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting report',
      error: error.message
    });
  }
};

// Get report statistics
exports.getReportStats = async (req, res) => {
  try {
    const stats = await Report.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);

    const formattedStats = {};
    stats.forEach(stat => {
      formattedStats[stat._id] = stat.count;
    });

    res.json({
      success: true,
      stats: formattedStats
    });
  } catch (error) {
    console.error('Error fetching report stats:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching report statistics',
      error: error.message
    });
  }
};

// --- Comment Reports ---
const CommentReport = require('../models/CommentReport');

// Get all comment reports
exports.getAllCommentReports = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const status = req.query.status;

    const query = status ? { status } : {};

    const reports = await CommentReport.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await CommentReport.countDocuments(query);

    res.json({
      success: true,
      reports,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching comment reports:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching comment reports',
      error: error.message
    });
  }
};

// Update comment report status
exports.updateCommentReportStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['pending', 'reviewed', 'removed', 'ignored'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status'
      });
    }

    const report = await CommentReport.findById(id);
    if (!report) {
      return res.status(404).json({
        success: false,
        message: 'Report not found'
      });
    }

    report.status = status;
    report.reviewedAt = new Date();
    // report.reviewedBy = req.admin?.id; // Uncomment if admin auth is available

    await report.save();

    res.json({
      success: true,
      message: 'Comment report status updated',
      report
    });
  } catch (error) {
    console.error('Error updating comment report status:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating status',
      error: error.message
    });
  }
};

// Delete comment report
exports.deleteCommentReport = async (req, res) => {
  try {
    const { id } = req.params;
    const report = await CommentReport.findByIdAndDelete(id);

    if (!report) {
      return res.status(404).json({
        success: false,
        message: 'Report not found'
      });
    }

    res.json({
      success: true,
      message: 'Comment report deleted'
    });
  } catch (error) {
    console.error('Error deleting comment report:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting report',
      error: error.message
    });
  }
};

// Delete the actual comment content
exports.deleteCommentContent = async (req, res) => {
  try {
    const { id } = req.params; // Report ID
    const News = require('../models/News');

    // Find the report to get details
    const report = await CommentReport.findById(id);
    if (!report) {
      return res.status(404).json({ success: false, message: 'Report not found' });
    }

    // Find the news article
    const news = await News.findById(report.newsId);
    if (!news) {
      return res.status(404).json({ success: false, message: 'News article not found' });
    }

    // Remove the comment from userInteractions
    if (news.userInteractions && news.userInteractions.comments) {
      const initialLength = news.userInteractions.comments.length;

      // Filter out the comment matching text and user
      // Note: Since we don't store commentId in report, we match by text and user
      news.userInteractions.comments = news.userInteractions.comments.filter(c =>
        !(c.comment === report.commentText && String(c.userId) === String(report.commentUserId))
      );

      // If a comment was removed, update the count
      if (news.userInteractions.comments.length < initialLength) {
        news.comments = Math.max(0, news.comments - 1);
        await news.save();

        // Update report status to 'removed'
        report.status = 'removed';
        await report.save();

        // Emit Socket.io event to notify Flutter clients
        const io = req.app.get('io');
        if (io) {
          io.emit('comment_deleted', {
            newsId: String(report.newsId),
            commentText: report.commentText,
            userId: String(report.commentUserId),
            timestamp: new Date().toISOString()
          });
          console.log('📤 Emitted comment_deleted event for newsId:', report.newsId);
        }

        return res.json({
          success: true,
          message: 'Comment deleted successfully and report marked as removed'
        });
      } else {
        return res.status(404).json({
          success: false,
          message: 'Comment not found in the news article (it might have been deleted already)'
        });
      }
    } else {
      return res.status(404).json({ success: false, message: 'No comments found in this news article' });
    }

  } catch (error) {
    console.error('Error deleting comment content:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting comment',
      error: error.message
    });
  }
};