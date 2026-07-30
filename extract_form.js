const fs = require('fs');
const path = require('path');

const editorsPath = path.join(__dirname, 'views', 'editors.ejs');
const registerPath = path.join(__dirname, 'views', 'register-editor.ejs');

let editorsContent = fs.readFileSync(editorsPath, 'utf-8');
let registerContent = fs.readFileSync(registerPath, 'utf-8');

// Extract HTML
const tabsStart = editorsContent.indexOf('<div class="editor-tabs" id="addEditorTabs">');
const formEnd = editorsContent.indexOf('</form>', tabsStart) + '</form>'.length;
let addFormHtml = editorsContent.substring(tabsStart, formEnd);

// Wrap HTML in a styled container for the page
addFormHtml = `
<div class="editor-page-container" style="background: #fff; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); padding: 30px; max-width: 1000px; margin: 0 auto;">
    ${addFormHtml.replace(/btn-outline-secondary/g, 'btn-light').replace(/data-bs-dismiss="modal"/g, 'onclick="window.history.back()"')}
</div>
`;

// Extract required JS blocks from editors.ejs
// We need everything from `const _activeLanguages` to the end, but filtering out things specific to the list view.
// It's safer to just extract all the helper functions: switchEditorTab, validateAddEditorTab, initRoleCards, initScopeCards, initLangCards, etc.
// And the location chips logic: fetchLocationHierarchy, renderLocationChips, updateSubEditorLocationChips, applyAddSubEditorVisibility, etc.

// Let's grab the entire script block from editors.ejs
const scriptStart = editorsContent.indexOf('<script>', editorsContent.lastIndexOf('<footer'));
const scriptEnd = editorsContent.lastIndexOf('</script>');
let fullScript = editorsContent.substring(scriptStart, scriptEnd + '</script>'.length);

// Now replace the <div class="reg-layout">...</div> in register-editor.ejs
const regLayoutStart = registerContent.indexOf('<div class="reg-layout">');
const regLayoutEnd = registerContent.indexOf('</script>', regLayoutStart) + '</script>'.length;

let newRegisterContent = registerContent.substring(0, regLayoutStart) + 
                         addFormHtml + 
                         '\n</div>\n</div>\n</div>\n</div>\n<%- include(\'partials/footer\') %>\n' + 
                         fullScript + 
                         '\n</body>\n</html>';

fs.writeFileSync(registerPath, newRegisterContent);
console.log('Successfully updated register-editor.ejs');
