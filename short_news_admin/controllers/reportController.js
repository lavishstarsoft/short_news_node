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
    
    // First get reports with news populated
    let reports = await Report.find()
      .populate('newsId', 'title content')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);
      
    // Then populate user information for each report
    const User = require('../models/User');
    reports = await Promise.all(reports.map(async (report) => {
      // Try to find user by userId (which is the user's _id for mobile users)
      let user = await User.findById(report.userId);
      
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
      
    const total = await Report.countDocuments();
    
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
    reports = await Promise.all(reports.map(async (report) => {
      // Try to find user by userId (which is the user's _id for mobile users)
      let user = await User.findById(report.userId);
      
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