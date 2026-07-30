const fs = require('fs');
const path = require('path');
const editorsPath = path.join(__dirname, 'views', 'editors.ejs');
const registerPath = path.join(__dirname, 'views', 'register-editor.ejs');

let editorsContent = fs.readFileSync(editorsPath, 'utf-8');
let registerContent = fs.readFileSync(registerPath, 'utf-8');

// 1. Extract <style>
const styleStart = editorsContent.indexOf('<style>');
const styleEnd = editorsContent.indexOf('</style>') + '</style>'.length;
const styleBlock = editorsContent.substring(styleStart, styleEnd);

// 2. Extract addEditorTabs and addEditorForm
const tabsStart = editorsContent.indexOf('<div class="editor-tabs" id="addEditorTabs">');
const formEnd = editorsContent.indexOf('</form>', tabsStart) + '</form>'.length;
let addFormHtml = editorsContent.substring(tabsStart, formEnd);
addFormHtml = addFormHtml.replace(/btn-outline-secondary/g, 'btn-light').replace(/data-bs-dismiss="modal"/g, 'onclick="window.history.back()"');

// Wrap it full width
const wrappedHtml = `
<div class="editor-page-container w-100" style="background: #fff; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); padding: 30px;">
    ${addFormHtml}
</div>
`;

// 3. Extract exact JS block
const lines = editorsContent.split('\n');
const jsLines = lines.slice(1305, 2753); // 0-indexed: lines 1306 to 2753 (exclusive of end index, so it gets up to 2753)
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
    "}\n\n                    document.getElementById('addEditorForm').addEventListener('submit', function (e) {"
);

const oldSuccess = `showFeedback(result.message || 'Editor added', 'success');
                                    bootstrap.Modal.getInstance(document.getElementById('addEditorModal')).hide();
                                    setTimeout(() => location.reload(), 1000);`;
const newSuccess = `if (typeof showFeedback === 'function') showFeedback(result.message || 'Editor added', 'success');
                                    else alert(result.message || 'Editor added');
                                    setTimeout(() => window.location.href = '/editors', 1000);`;
jsBlock = jsBlock.replace(oldSuccess, newSuccess);

// 4. Update registerContent
// Replace header css link
registerContent = registerContent.replace('<link rel="stylesheet" href="/css/team-register.css">', styleBlock);

// Replace page title
const regHeroStart = registerContent.indexOf('<header class="reg-hero">');
const regHeroEnd = registerContent.indexOf('</header>') + '</header>'.length;
if (regHeroStart !== -1) {
    registerContent = registerContent.substring(0, regHeroStart) + 
                      '<h2 class="mb-4"><i class="fas fa-user-plus me-2 text-primary"></i> Add New Member</h2>' + 
                      registerContent.substring(regHeroEnd);
}
registerContent = registerContent.replace('<div class="reg-page content-area mt-4">', '<div class="content-area mt-4">');

// Replace form area
const regLayoutStart = registerContent.indexOf('<div class="reg-layout">');
const regLayoutEnd = registerContent.indexOf('</div>\n                </div>', regLayoutStart);
registerContent = registerContent.substring(0, regLayoutStart) + wrappedHtml + registerContent.substring(regLayoutEnd);

// Replace script area
const regScriptStart = registerContent.indexOf('<script>', registerContent.indexOf('partials/footer'));
const regScriptEnd = registerContent.lastIndexOf('</script>');
registerContent = registerContent.substring(0, regScriptStart) + jsBlock + '\n' + registerContent.substring(regScriptEnd + '</script>'.length);

fs.writeFileSync(registerPath, registerContent);
console.log('Successfully updated register-editor.ejs');
