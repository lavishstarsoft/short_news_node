const ejs = require('ejs');
const fs = require('fs');

const template = fs.readFileSync('/Users/saisudhakarmanchala/projects/Shortnews_main_mac/Node/views/add-news.ejs', 'utf-8');

try {
  const compiled = ejs.compile(template);
  console.log("Compilation successful!");
} catch (err) {
  console.error("Compilation error:", err.message);
}
