const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, 'views', 'register-editor.ejs');
let c = fs.readFileSync(p, 'utf-8');
c = c.replace(/root\.closest\('\.modal-content'\)/g, "root.closest('.editor-page-container')");
fs.writeFileSync(p, c);
console.log('Fixed root.closest() for tabs');
