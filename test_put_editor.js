const mongoose = require('mongoose');
require('dotenv').config();
const Admin = require('./models/Admin');

async function test() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to DB');

  try {
    // find a subeditor
    const editor = await Admin.findOne({ role: 'subeditor' });
    if (!editor) {
        console.log('No subeditor found');
        return;
    }
    console.log('Found subeditor:', editor.username);

    // Mock update request exactly like updateEditor
    const body = {
        name: editor.name,
        role: 'subeditor',
        displayRole: editor.displayRole,
        assignedStates: ['Uttar Pradesh'],
        assignedState: 'Uttar Pradesh',
        assignedDistricts: [],
        assignedConstituencies: [],
        managedStates: ['Uttar Pradesh'],
        managedDistricts: [],
        managedConstituencies: [],
        managedReporterIds: [],
        approvalScope: 'geography',
        allowedScopes: ['state'],
        workingLanguage: 'te',
        constituency: '',
        mobileNumber: '9999999999',
        profileImage: '',
        displaySettings: {
            showProfileImage: true,
            showName: true,
            showConstituency: true
        },
        canViewReporterDetails: true,
        canAccessAdminDashboard: true,
        canApproveNews: true,
        canViewAllNews: true,
        canSendNotifications: false,
        canEditNews: false,
        requiresSourceLink: false,
        sidebar: {}
    };

    const req = { body, params: { id: editor._id } };
    const res = {
        status: function(code) { this.statusCode = code; return this; },
        json: function(data) { console.log('Response:', this.statusCode, data); }
    };
    
    // Instead of importing the whole controller, let's just do what it does:
    const { applyReporterCoverageFields } = require('./utils/editorCoverageHelper');
    const { applySubEditorCoveragePermissions } = require('./utils/editorCoverageHelper');

    if (body.name !== undefined) editor.name = body.name || null;
    if (body.displayRole !== undefined) editor.displayRole = body.displayRole || 'Reporter';
    if (body.location !== undefined) editor.location = body.location || null;
    applyReporterCoverageFields(editor, {
      assignedStates: body.assignedStates, assignedState: body.assignedState, assignedDistricts: body.assignedDistricts, assignedConstituencies: body.assignedConstituencies,
      assignedLocations: body.assignedLocations, constituency: body.constituency
    });
    if (body.constituency !== undefined) editor.constituency = body.constituency || null;
    if (body.allowedScopes !== undefined) {
      editor.allowedScopes = Array.isArray(body.allowedScopes) ? body.allowedScopes : [];
    }
    if (body.mobileNumber !== undefined) editor.mobileNumber = body.mobileNumber || null;
    if (body.profileImage !== undefined) editor.profileImage = body.profileImage || null;
    if (body.workingLanguage !== undefined) editor.workingLanguage = 'te';

    if (body.displaySettings !== undefined) {
      if (!editor.displaySettings) editor.displaySettings = { showProfileImage: true, showName: true, showConstituency: true };
      
      if (body.displaySettings.showProfileImage !== undefined) {
        editor.displaySettings.showProfileImage = body.displaySettings.showProfileImage === 'true' || body.displaySettings.showProfileImage === true;
      }
      if (body.displaySettings.showName !== undefined) {
        editor.displaySettings.showName = body.displaySettings.showName === 'true' || body.displaySettings.showName === true;
      }
      if (body.displaySettings.showConstituency !== undefined) {
        editor.displaySettings.showConstituency = body.displaySettings.showConstituency === 'true' || body.displaySettings.showConstituency === true;
      }
    }

    if (body.canViewReporterDetails !== undefined || body.canAccessAdminDashboard !== undefined || body.canApproveNews !== undefined || body.canViewAllNews !== undefined) {
      if (!editor.permissions) editor.permissions = {};
      if (body.canViewReporterDetails !== undefined) {
        editor.permissions.canViewReporterDetails = body.canViewReporterDetails === 'true' || body.canViewReporterDetails === true;
      }
      if (body.canAccessAdminDashboard !== undefined) {
        editor.permissions.canAccessAdminDashboard = body.canAccessAdminDashboard === 'true' || body.canAccessAdminDashboard === true;
      }
      if (body.canApproveNews !== undefined) {
        editor.permissions.canApproveNews = body.canApproveNews === 'true' || body.canApproveNews === true;
      }
      if (body.canViewAllNews !== undefined) {
        editor.permissions.canViewAllNews = body.canViewAllNews === 'true' || body.canViewAllNews === true;
      }
    }
    
    if (body.approvalScope !== undefined || body.managedLocations !== undefined || body.managedStates !== undefined ||
        body.managedDistricts !== undefined || body.managedConstituencies !== undefined || body.managedReporterIds !== undefined) {
      if (!editor.permissions) editor.permissions = {};
      applySubEditorCoveragePermissions(editor, {
        approvalScope: body.approvalScope, managedLocations: body.managedLocations, managedStates: body.managedStates, managedDistricts: body.managedDistricts,
        managedConstituencies: body.managedConstituencies, managedReporterIds: body.managedReporterIds
      });
    }

    await editor.save();
    console.log('Successfully saved to DB');
  } catch (e) {
    console.error('Error saving:', e.message);
    if (e.errors) {
      console.error(e.errors);
    }
  }

  mongoose.disconnect();
}
test();
