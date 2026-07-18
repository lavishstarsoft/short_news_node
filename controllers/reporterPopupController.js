const ReporterPopup = require('../models/ReporterPopup');
const PopupInteraction = require('../models/PopupInteraction');
const Admin = require('../models/Admin');

exports.renderPopupsPage = async (req, res) => {
  res.render('admin/popups', {
    pageTitle: 'In-App Popups',
    path: '/popups',
    admin: req.admin
  });
};

exports.getPopups = async (req, res) => {
  try {
    const { language, activeOnly } = req.query;
    const filter = {};
    if (language) filter.language = language.toLowerCase();
    if (activeOnly === 'true') filter.isActive = true;

    const popups = await ReporterPopup.find(filter)
      .populate('createdBy', 'username')
      .sort({ createdAt: -1 });

    res.json({ success: true, data: popups });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.createPopup = async (req, res) => {
  try {
    const popupData = req.body;
    popupData.createdBy = req.admin._id;
    
    // Ensure arrays are arrays
    ['targetRoles', 'targetStates', 'targetDistricts', 'targetReporters'].forEach(field => {
      if (popupData[field] && !Array.isArray(popupData[field])) {
        popupData[field] = [popupData[field]];
      }
    });

    const popup = new ReporterPopup(popupData);
    await popup.save();

    res.status(201).json({ success: true, data: popup });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updatePopup = async (req, res) => {
  try {
    const popupData = req.body;
    
    // Ensure arrays are arrays
    ['targetRoles', 'targetStates', 'targetDistricts', 'targetReporters'].forEach(field => {
      if (popupData[field] && !Array.isArray(popupData[field])) {
        popupData[field] = [popupData[field]];
      }
    });

    const popup = await ReporterPopup.findByIdAndUpdate(req.params.id, popupData, { new: true });
    if (!popup) {
      return res.status(404).json({ success: false, message: 'Popup not found' });
    }

    res.json({ success: true, data: popup });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.deletePopup = async (req, res) => {
  try {
    const popup = await ReporterPopup.findByIdAndDelete(req.params.id);
    if (!popup) {
      return res.status(404).json({ success: false, message: 'Popup not found' });
    }
    // Also delete interactions
    await PopupInteraction.deleteMany({ popupId: req.params.id });
    
    res.json({ success: true, message: 'Popup deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Reporter Dashboard APIs

exports.getActiveReporterPopup = async (req, res) => {
  try {
    const reporter = req.admin; // In the reporter system, reporters use the Admin collection
    if (!reporter) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const language = (reporter.workingLanguage || 'te').toLowerCase();
    const currentDate = new Date();

    // Base filters: Active, matching language, within date range
    const filter = {
      isActive: true,
      language: language,
      startDate: { $lte: currentDate },
      $or: [{ endDate: null }, { endDate: { $gt: currentDate } }]
    };

    // Find all potential popups for this reporter's language
    const potentialPopups = await ReporterPopup.find(filter).sort({ 
      // Sort by priority. We'll map priority to a numeric value in memory, 
      // but DB sort by createdAt so newest is first fallback.
      createdAt: -1 
    });

    if (potentialPopups.length === 0) {
      return res.json({ success: true, data: null });
    }

    // Filter by targeting
    const validPopups = potentialPopups.filter(popup => {
      // Role match
      const roleMatch = popup.targetRoles.includes('all') || popup.targetRoles.includes(reporter.role);
      
      // State match
      const stateMatch = popup.targetStates.length === 0 || popup.targetStates.includes(reporter.assignedState);
      
      // District match (checking if any of reporter's assigned districts overlap)
      const districtMatch = popup.targetDistricts.length === 0 || 
        (reporter.assignedDistricts && reporter.assignedDistricts.some(d => popup.targetDistricts.includes(d)));
        
      // Reporter ID match
      const reporterMatch = popup.targetReporters.length === 0 || popup.targetReporters.some(id => id.toString() === reporter._id.toString());

      return roleMatch && stateMatch && districtMatch && reporterMatch;
    });

    if (validPopups.length === 0) {
      return res.json({ success: true, data: null });
    }

    // Sort by priority (critical > high > medium > low)
    const priorityWeight = { 'critical': 4, 'high': 3, 'medium': 2, 'low': 1 };
    validPopups.sort((a, b) => {
      const weightA = priorityWeight[a.priority] || 0;
      const weightB = priorityWeight[b.priority] || 0;
      if (weightA !== weightB) return weightB - weightA;
      // If same priority, newest first
      return b.createdAt - a.createdAt;
    });

    // Check interactions to handle 'frequency' rules (once, daily, always)
    let selectedPopup = null;

    for (const popup of validPopups) {
      if (popup.frequency === 'always') {
        selectedPopup = popup;
        break;
      }

      // Check interactions
      const interactions = await PopupInteraction.find({
        popupId: popup._id,
        reporterId: reporter._id
      }).sort({ timestamp: -1 });

      // If never seen/dismissed, show it
      if (interactions.length === 0) {
        selectedPopup = popup;
        break;
      }

      const lastInteraction = interactions[0];

      if (popup.frequency === 'once') {
        // If they ever dismissed it, don't show. If they only viewed it, maybe show again depending on strictness.
        // Usually, we just check if it was dismissed.
        const hasDismissed = interactions.some(i => i.action === 'dismissed');
        if (!hasDismissed) {
          selectedPopup = popup;
          break;
        }
      } else if (popup.frequency === 'daily') {
        // Has it been dismissed today?
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const dismissedToday = interactions.some(i => i.action === 'dismissed' && i.timestamp >= today);
        if (!dismissedToday) {
          selectedPopup = popup;
          break;
        }
      }
    }

    res.json({ success: true, data: selectedPopup });
  } catch (error) {
    console.error('Error fetching active popup:', error);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
};

exports.recordPopupInteraction = async (req, res) => {
  try {
    const { action } = req.body;
    const popupId = req.params.id;
    const reporterId = req.admin._id;

    if (!['viewed', 'dismissed'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Invalid action' });
    }

    const interaction = new PopupInteraction({
      popupId,
      reporterId,
      action
    });

    await interaction.save();

    res.json({ success: true });
  } catch (error) {
    console.error('Error recording popup interaction:', error);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
};
