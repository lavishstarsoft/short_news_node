const fs = require('fs');
const path = require('path');

const registerPath = path.join(__dirname, 'views', 'register-editor.ejs');
let content = fs.readFileSync(registerPath, 'utf-8');

// Wrap editEditorForm
content = content.replace(
    "document.getElementById('editEditorForm').addEventListener('submit', function (e) {",
    "const editFormEl = document.getElementById('editEditorForm');\nif (editFormEl) editFormEl.addEventListener('submit', function (e) {"
);

// Wrap editProfileImageUpload
content = content.replace(
    "document.getElementById('editProfileImageUpload').addEventListener('change', function(e) {",
    "const editImgEl = document.getElementById('editProfileImageUpload');\nif (editImgEl) editImgEl.addEventListener('change', function(e) {"
);

// We need to find the addEditorForm fetch success handler and fix it.
// In the current file, since it's already messed up, maybe I should rerun extract_form.js first.
