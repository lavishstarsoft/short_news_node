const fs = require('fs');
const path = require('path');
const editorsPath = path.join(__dirname, 'views', 'editors.ejs');
const registerPath = path.join(__dirname, 'views', 'register-editor.ejs');

let editorsContent = fs.readFileSync(editorsPath, 'utf-8');
let registerContent = fs.readFileSync(registerPath, 'utf-8');

// Grab <style> from editors.ejs
const styleStart = editorsContent.indexOf('<style>');
const styleEnd = editorsContent.indexOf('</style>') + '</style>'.length;
const styleBlock = editorsContent.substring(styleStart, styleEnd);

// Find the header include in registerContent
const headerInclude = '<link rel="stylesheet" href="/css/team-register.css">';
registerContent = registerContent.replace(headerInclude, headerInclude + '\n' + styleBlock);

// Remove the reg-hero header
const regHeroStart = registerContent.indexOf('<header class="reg-hero">');
const regHeroEnd = registerContent.indexOf('</header>') + '</header>'.length;
if (regHeroStart !== -1) {
    registerContent = registerContent.replace(registerContent.substring(regHeroStart, regHeroEnd), '<h2 class="mb-4"><i class="fas fa-user-plus me-2 text-primary"></i> Add New Member</h2>');
}

// Remove reg-page class which might break standard layout
registerContent = registerContent.replace('<div class="reg-page content-area mt-4">', '<div class="content-area mt-4">');

fs.writeFileSync(registerPath, registerContent);
console.log('Fixed register-editor layout and styles');
