const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, 'views', 'register-editor.ejs');
let c = fs.readFileSync(p, 'utf-8');

// 1. Hide tabs navigation
c = c.replace('<div class="editor-tabs" id="addEditorTabs">', '<div class="editor-tabs d-none" id="addEditorTabs">');

// 2. Add section headers to panels
c = c.replace(
    '<div class="editor-tab-panel active" id="add-tab-account">', 
    '<div class="editor-tab-panel active d-block" id="add-tab-account" style="padding-bottom: 2rem;">\n                                <h4 class="mb-4 border-bottom pb-2 text-primary fw-bold"><i class="fas fa-user-circle me-2"></i> Account Details</h4>'
);

c = c.replace(
    '<div class="editor-tab-panel" id="add-tab-profile">', 
    '<div class="editor-tab-panel d-block" id="add-tab-profile" style="padding-bottom: 2rem;">\n                                <h4 class="mb-4 border-bottom pb-2 text-primary fw-bold"><i class="fas fa-id-badge me-2"></i> Profile Information</h4>'
);

c = c.replace(
    '<div class="editor-tab-panel" id="add-tab-location">', 
    '<div class="editor-tab-panel d-block" id="add-tab-location" style="padding-bottom: 2rem;">\n                                <h4 class="mb-4 border-bottom pb-2 text-primary fw-bold"><i class="fas fa-map-marker-alt me-2"></i> Regional Coverage</h4>'
);

c = c.replace(
    '<div class="editor-tab-panel" id="add-tab-perms">', 
    '<div class="editor-tab-panel d-block" id="add-tab-perms" style="padding-bottom: 2rem;">\n                                <h4 class="mb-4 border-bottom pb-2 text-primary fw-bold"><i class="fas fa-shield-alt me-2"></i> Permissions & Settings</h4>'
);

// 3. Fix footer buttons
const footerOld = `<button type="button" class="btn btn-light" onclick="window.history.back()">Cancel</button>
                                <button type="button" class="btn btn-primary px-4" id="addNextBtn">Next <i class="fas fa-arrow-right ms-1"></i></button>
                                <button type="submit" class="btn btn-success px-4" id="addSubmitBtn" style="display: none;">Register Member <i class="fas fa-check ms-1"></i></button>`;

const footerNew = `<button type="button" class="btn btn-light" onclick="window.history.back()">Cancel</button>
                                <button type="submit" class="btn btn-success px-5 py-2 fs-5 fw-bold w-100 mt-3 shadow-sm" id="addSubmitBtn">Register Team Member <i class="fas fa-check-circle ms-2"></i></button>`;
c = c.replace(footerOld, footerNew);

// Override CSS just in case
const cssOverride = `
<style>
    .editor-tab-panel { display: block !important; border: 1px solid #eee; border-radius: 10px; margin-bottom: 25px; background: #fafafa; padding: 30px !important; }
    .editor-modal-footer { display: flex; flex-direction: column; align-items: stretch; border-top: 2px dashed #ddd; padding-top: 20px; }
    .editor-modal-footer .btn-light { align-self: flex-start; }
</style>
`;
c = c.replace('</style>', '</style>\n' + cssOverride);

fs.writeFileSync(p, c);
console.log('Redesign completed!');
