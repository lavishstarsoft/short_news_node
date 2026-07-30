const fs = require('fs');
const path = require('path');
const registerPath = path.join(__dirname, 'views', 'register-editor.ejs');
let content = fs.readFileSync(registerPath, 'utf-8');

// Fix addEditorForm fetch logic
const oldSuccess = `showFeedback(result.message || 'Editor added', 'success');
                                    bootstrap.Modal.getInstance(document.getElementById('addEditorModal')).hide();
                                    setTimeout(() => location.reload(), 1000);`;
const newSuccess = `if (typeof showFeedback === 'function') showFeedback(result.message || 'Editor added', 'success');
                                    else alert(result.message || 'Editor added');
                                    setTimeout(() => window.location.href = '/editors', 1000);`;
content = content.replace(oldSuccess, newSuccess);
fs.writeFileSync(registerPath, content);
console.log('Fixed addEditorForm success handler');
