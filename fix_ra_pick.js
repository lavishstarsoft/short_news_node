const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, 'views', 'reporter-applications.ejs');
let c = fs.readFileSync(p, 'utf-8');

c = c.replace(
    "function raPickString(data, keys) { for (let i=0; i < keys.length; i++) { const",
    "function raPickString(data, keys) { if (!data) return ''; for (let i=0; i < keys.length; i++) { const"
);
c = c.replace(
    "function raPickString(data, keys) { for (let i = 0; i < keys.length; i++) { const",
    "function raPickString(data, keys) { if (!data) return ''; for (let i=0; i < keys.length; i++) { const"
);
// fallback replacement in case formatting is slightly different
c = c.replace(
    /function raPickString\(data, keys\) \{[\s\n]*for \(let i\s*=\s*0;/g,
    "function raPickString(data, keys) { if (!data) return ''; for (let i = 0;"
);

// Also replace the EJS inline call to be very safe
c = c.replace(
    "<% const locationStr = (app.data && typeof raPickString === 'function') ? raPickString(app.data, ['district', 'District', 'mandal', 'Mandal', 'village', 'Village', 'constituency', 'Constituency', 'city', 'City', 'location', 'Location']) : ''; %>",
    "<% const locationStr = (typeof raPickString === 'function') ? raPickString(app.data || {}, ['district', 'District', 'mandal', 'Mandal', 'village', 'Village', 'constituency', 'Constituency', 'city', 'City', 'location', 'Location']) : ''; %>"
);

fs.writeFileSync(p, c);
console.log('Fixed raPickString');
