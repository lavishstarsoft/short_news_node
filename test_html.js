const fs = require('fs');
const html = fs.readFileSync('views/editors.ejs', 'utf-8');

// Find the form
const formStart = html.indexOf('<form id="editEditorForm">');
const formEnd = html.indexOf('</form>', formStart);
const formHtml = html.substring(formStart, formEnd);

// Check if any element has 'required'
const requiredFields = formHtml.match(/<[^>]+required[^>]*>/g);
console.log('Required fields in editEditorForm:', requiredFields);
