const ejs = require('ejs');
const app = { data: { "email": "snblalitpur@gmail.com", "phone_number": "7355975248", "Name": "Neeraj Kumar", "Location": "Lalitpur (UP)" } };

const template = `
<% 
function raIsUrl(value) { return false; }
function raPickString(data, keys) { if (!data) return ''; for (let i=0; i < keys.length; i++) { const val=data[keys[i]]; if (val && typeof val==='string' && val.trim() && !raIsUrl(val)) return val.trim(); } return '' ; } 
function raGetName(data) { return data.Name; }
function raGetEmail(data) { return raPickString(data, ['email', 'phone_number']); }
function raGetPhone(data) { return data.phone_number; }

const raApps = [app];
raApps.forEach(function(app) {
    const name = raGetName(app.data);
    const email = app.data.email;
    const phone = raGetPhone(app.data);
    const meta = [email, phone].filter(Boolean).join(' · ') || ' No contact details'; 
%>
    meta: <%= meta %>
    <% const locationStr = (typeof raPickString === 'function') ? raPickString(app.data || {}, ['district', 'District', 'mandal', 'Mandal', 'village', 'Village', 'constituency', 'Constituency', 'city', 'City', 'location', 'Location']) : ''; %>
    href="/register-editor?source=application&email=<%= encodeURIComponent(email || '') %>&name=<%= encodeURIComponent(name || '') %>&mobile=<%= encodeURIComponent(phone || '') %>&location=<%= encodeURIComponent(locationStr || '') %>"
<% }); %>
`;

console.log(ejs.render(template, { app }));
