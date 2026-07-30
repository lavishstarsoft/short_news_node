const fs = require('fs');
const path = require('path');
const editorsPath = path.join(__dirname, 'views', 'editors.ejs');
const registerPath = path.join(__dirname, 'views', 'register-editor.ejs');

let editorsContent = fs.readFileSync(editorsPath, 'utf-8');
let registerContent = fs.readFileSync(registerPath, 'utf-8');

// 1. Extract <style> from editors.ejs
const styleStart = editorsContent.indexOf('<style>');
const styleEnd = editorsContent.indexOf('</style>') + '</style>'.length;
const styleBlock = editorsContent.substring(styleStart, styleEnd);

// 2. Extract addEditorTabs and addEditorForm
const tabsStart = editorsContent.indexOf('<div class="editor-tabs" id="addEditorTabs">');
const formEnd = editorsContent.indexOf('</form>', tabsStart) + '</form>'.length;
let addFormHtml = editorsContent.substring(tabsStart, formEnd);
addFormHtml = addFormHtml.replace(/btn-outline-secondary/g, 'btn-light').replace(/data-bs-dismiss="modal"/g, 'onclick="window.history.back()"');

// Make tabs look like a beautiful wizard step progress bar
const wizardStyles = `
<style>
    .editor-page-container { background: #fff; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.08); padding: 40px; margin: 20px auto; min-height: 70vh; }
    .wizard-header { margin-bottom: 30px; text-align: center; }
    
    #addEditorTabs { 
        display: flex; 
        justify-content: space-between; 
        border-bottom: 2px solid #eee; 
        padding-bottom: 15px; 
        margin-bottom: 30px; 
        background: transparent;
        padding-left: 0;
        padding-right: 0;
    }
    #addEditorTabs .editor-tab-btn {
        flex: 1;
        background: none;
        border: none;
        color: #888;
        font-weight: 600;
        font-size: 16px;
        padding: 10px;
        position: relative;
        text-transform: uppercase;
        letter-spacing: 1px;
    }
    #addEditorTabs .editor-tab-btn::after {
        content: '';
        position: absolute;
        bottom: -17px;
        left: 0;
        width: 100%;
        height: 4px;
        background: #eee;
        border-radius: 2px;
        transition: all 0.3s ease;
    }
    #addEditorTabs .editor-tab-btn.active { color: #0056b3; }
    #addEditorTabs .editor-tab-btn.active::after { background: #0056b3; }
    
    .editor-tab-panel { padding: 20px; }
    .editor-modal-footer { 
        border-top: 1px solid #eee; 
        padding-top: 25px; 
        margin-top: 20px; 
        display: flex; 
        justify-content: space-between; 
        align-items: center;
    }
    
    .editor-modal-footer .btn { padding: 12px 30px; font-weight: bold; font-size: 16px; border-radius: 8px; }
</style>
`;

const wrappedHtml = `
${wizardStyles}
<div class="editor-page-container w-100">
    <div class="wizard-header">
        <h2 class="fw-bold text-dark mb-2">Register Team Member</h2>
        <p class="text-muted">Complete the steps below to onboard a new Sub-Editor or Reporter.</p>
    </div>
    ${addFormHtml}
</div>
`;

// 3. Extract exact JS block
const lines = editorsContent.split('\n');
const jsLines = lines.slice(1305, 2753); // 1306 to 2753
let jsBlock = jsLines.join('\n');

jsBlock = jsBlock.replace(
    "document.getElementById('editEditorForm').addEventListener('submit', function (e) {",
    "const editFormEl = document.getElementById('editEditorForm');\nif (editFormEl) editFormEl.addEventListener('submit', function (e) {"
);
jsBlock = jsBlock.replace(
    "document.getElementById('editProfileImageUpload').addEventListener('change', function(e) {",
    "const editImgEl = document.getElementById('editProfileImageUpload');\nif (editImgEl) editImgEl.addEventListener('change', function(e) {"
);
jsBlock = jsBlock.replace(
    "document.getElementById('addEditorForm').addEventListener('submit', function (e) {",
    "document.getElementById('addEditorForm').addEventListener('submit', function (e) {"
);

// Fix the `.modal-content` bug for tab navigation
jsBlock = jsBlock.replace(/root\.closest\('\.modal-content'\)/g, "root.closest('.editor-page-container')");

const oldSuccess = `showFeedback(result.message || 'Editor added', 'success');
                                    bootstrap.Modal.getInstance(document.getElementById('addEditorModal')).hide();
                                    setTimeout(() => location.reload(), 1000);`;
const newSuccess = `if (typeof showFeedback === 'function') showFeedback(result.message || 'Editor added', 'success');
                                    else alert(result.message || 'Editor added');
                                    setTimeout(() => window.location.href = '/editors', 1000);`;
jsBlock = jsBlock.replace(oldSuccess, newSuccess);

// Restore fresh register-editor.ejs first
const { execSync } = require('child_process');
execSync('git checkout views/register-editor.ejs');

let freshRegister = fs.readFileSync(registerPath, 'utf-8');

freshRegister = freshRegister.replace('<link rel="stylesheet" href="/css/team-register.css">', styleBlock);

const regHeroStart = freshRegister.indexOf('<header class="reg-hero">');
const regHeroEnd = freshRegister.indexOf('</header>') + '</header>'.length;
if (regHeroStart !== -1) {
    freshRegister = freshRegister.substring(0, regHeroStart) + freshRegister.substring(regHeroEnd);
}
freshRegister = freshRegister.replace('<div class="reg-page content-area mt-4">', '<div class="content-area mt-4">');

const regLayoutStart = freshRegister.indexOf('<div class="reg-layout">');
const regLayoutEnd = freshRegister.indexOf('</div>\n                </div>', regLayoutStart);
freshRegister = freshRegister.substring(0, regLayoutStart) + wrappedHtml + freshRegister.substring(regLayoutEnd);

const regScriptStart = freshRegister.indexOf('<script>', freshRegister.indexOf('partials/footer'));
const regScriptEnd = freshRegister.lastIndexOf('</script>');
freshRegister = freshRegister.substring(0, regScriptStart) + jsBlock + '\n' + freshRegister.substring(regScriptEnd + '</script>'.length);

fs.writeFileSync(registerPath, freshRegister);
console.log('Successfully rebuilt register-editor.ejs with wizard layout!');
