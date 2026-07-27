const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'views/my-ai-queue.ejs');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Fix the "Publish Anyway" onclick
content = content.replace(
    /onclick="executeApproval\('\$\{articleId\}'\)"/g,
    'onclick="approveNews(\'${articleId}\', \'${escapeHtml(payload.title || \\'\\').replace(/\\'/g, \\"\\\\\\'\\")}\')"'
);

// 2. Move openCompareArticlesModal and closeCompareArticlesModal out of DOMContentLoaded
const functionRegex = /            function closeCompareArticlesModal\(\) \{[\s\S]*?modal\.style\.display = 'block';\n            \}\n/g;

const match = content.match(functionRegex);
if (match) {
    const functionsStr = match[0];
    // Remove it from its current location
    content = content.replace(functionsStr, '');
    
    // Find the DOMContentLoaded start
    const domLoadedIndex = content.indexOf("document.addEventListener('DOMContentLoaded', async function() {");
    
    // Insert it before DOMContentLoaded
    if (domLoadedIndex !== -1) {
        content = content.slice(0, domLoadedIndex) + functionsStr + '\n            ' + content.slice(domLoadedIndex);
    }
}

fs.writeFileSync(filePath, content, 'utf8');
console.log('Fixed my-ai-queue.ejs');
