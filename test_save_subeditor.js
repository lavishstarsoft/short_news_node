const mongoose = require('mongoose');
require('dotenv').config();
const Admin = require('./models/Admin');
const { applySubEditorCoveragePermissions } = require('./utils/editorCoverageHelper');

async function test() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/shortnews');
  console.log('Connected');

  try {
    let editor = await Admin.findOne({ username: 'test_subeditor_999' });
    if (!editor) {
      editor = new Admin({
        username: 'test_subeditor_999',
        email: 'test_subeditor_999@example.com',
        password: 'password123',
        role: 'subeditor'
      });
      await editor.save();
      console.log('Created editor');
    }

    editor.role = 'subeditor';
    if (!editor.permissions) editor.permissions = {};
    
    applySubEditorCoveragePermissions(editor, {
      approvalScope: 'geography',
      managedStates: ['Uttar Pradesh'],
      managedDistricts: [],
      managedConstituencies: [],
      managedReporterIds: []
    });

    await editor.save();
    console.log('Saved successfully:', editor.permissions.managedStates);
  } catch (e) {
    console.error('Error saving:', e.message);
    if (e.errors) {
      console.error(e.errors);
    }
  }

  mongoose.disconnect();
}

test();
