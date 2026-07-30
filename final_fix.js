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

// 2. Inject <style> into register-editor.ejs, replacing team-register.css
registerContent = registerContent.replace('<link rel="stylesheet" href="/css/team-register.css">', styleBlock);

// 3. Clean up the page headers
const regHeroStart = registerContent.indexOf('<header class="reg-hero">');
const regHeroEnd = registerContent.indexOf('</header>') + '</header>'.length;
if (regHeroStart !== -1) {
    registerContent = registerContent.substring(0, regHeroStart) + 
                      '<h2 class="mb-4"><i class="fas fa-user-plus me-2 text-primary"></i> Add New Member</h2>' + 
                      registerContent.substring(regHeroEnd);
}
registerContent = registerContent.replace('<div class="reg-page content-area mt-4">', '<div class="content-area mt-4">');

// 4. Extract addEditorTabs and addEditorForm from editors.ejs
const tabsStart = editorsContent.indexOf('<div class="editor-tabs" id="addEditorTabs">');
const formEnd = editorsContent.indexOf('</form>', tabsStart) + '</form>'.length;
let addFormHtml = editorsContent.substring(tabsStart, formEnd);

// Adjust modal footer buttons for the page
addFormHtml = addFormHtml.replace(/btn-outline-secondary/g, 'btn-light').replace(/data-bs-dismiss="modal"/g, 'onclick="window.history.back()"');

// Wrap it
const wrappedHtml = `
<div class="editor-page-container" style="background: #fff; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); padding: 30px; max-width: 1000px; margin: 0 auto;">
    ${addFormHtml}
</div>
`;

// Replace <div class="reg-layout">...</div>
const regLayoutStart = registerContent.indexOf('<div class="reg-layout">');
const regLayoutEnd = registerContent.indexOf('</div>\n                </div>', regLayoutStart);
registerContent = registerContent.substring(0, regLayoutStart) + wrappedHtml + registerContent.substring(regLayoutEnd);

// 5. Extract JS from editors.ejs
const scriptStart = editorsContent.indexOf('<script>', editorsContent.lastIndexOf('<footer'));
const scriptEnd = editorsContent.lastIndexOf('</script>');
let jsBlock = editorsContent.substring(scriptStart, scriptEnd + '</script>'.length);

// Fix edit wrappers in JS
jsBlock = jsBlock.replace(
    "document.getElementById('editEditorForm').addEventListener('submit', function (e) {",
    "const editFormEl = document.getElementById('editEditorForm');\nif (editFormEl) editFormEl.addEventListener('submit', function (e) {"
);
jsBlock = jsBlock.replace(
    "document.getElementById('editProfileImageUpload').addEventListener('change', function(e) {",
    "const editImgEl = document.getElementById('editProfileImageUpload');\nif (editImgEl) editImgEl.addEventListener('change', function(e) {"
);

// Close the if statement before addEditorForm
jsBlock = jsBlock.replace(
    "document.getElementById('addEditorForm').addEventListener('submit', function (e) {",
    "}\n\n                    document.getElementById('addEditorForm').addEventListener('submit', function (e) {"
);

// Fix addEditorForm success logic
const oldSuccess = `showFeedback(result.message || 'Editor added', 'success');
                                    bootstrap.Modal.getInstance(document.getElementById('addEditorModal')).hide();
                                    setTimeout(() => location.reload(), 1000);`;
const newSuccess = `if (typeof showFeedback === 'function') showFeedback(result.message || 'Editor added', 'success');
                                    else alert(result.message || 'Editor added');
                                    setTimeout(() => window.location.href = '/editors', 1000);`;
jsBlock = jsBlock.replace(oldSuccess, newSuccess);

// Replace the <script> block in registerContent
const regScriptStart = registerContent.indexOf('<script>', registerContent.lastIndexOf('<%- include(\'partials/footer\') %>'));
const regScriptEnd = registerContent.lastIndexOf('</script>');
registerContent = registerContent.substring(0, regScriptStart) + jsBlock + registerContent.substring(regScriptEnd + '</script>'.length);

fs.writeFileSync(registerPath, registerContent);
console.log('Successfully and perfectly updated register-editor.ejs');
