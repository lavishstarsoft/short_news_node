const ejs = require('ejs');
const path = require('path');
const fs = require('fs');

const appData = {
  "_id": "6a6aee9c035ffcc84206011c",
  "createdAt": new Date(),
  "status": "pending",
  "data": {
    "experience": "10",
    "Location": "Lalitpur (UP)",
    "Name": "Neeraj Kumar",
    "Father": "Keshav Das",
    "phone_number": "7355975248",
    "Alternate Mobile": "7355975248",
    "email": "snblalitpur@gmail.com",
    "REFERRED_BY": "Asraf Ansari"
  }
};

const mockLocals = {
  applications: [appData],
  registrationFields: [],
  admin: { role: 'admin' },
  pagination: { page: 1, totalPages: 1, totalApps: 1 }
};

const template = `
<% const raApps=typeof applications !=='undefined' ? applications : []; const raRegFields = [];
function raIsUrl(value) { return typeof value==='string' && (value.startsWith('http') || value.startsWith('/uploads') || value.includes('pub-')); } 
function raIsEmail(value) { return typeof value==='string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()); } 
function raIsPhone(value) { return typeof value==='string' && /^\\+?[\\d\\s()-]{8,}$/.test(value.replace(/\\s/g, '' )); }
function raPickString(data, keys) { if (!data) return ''; for (let i=0; i < keys.length; i++) { const val=data[keys[i]]; if (val && typeof val==='string' && val.trim() && !raIsUrl(val)) return val.trim(); } return '' ; } 
function raGetName(data) { if (!data || typeof data !=='object' ) return 'Applicant' ; for (let i=0; i < raRegFields.length; i++) { const field=raRegFields[i]; if (/name/i.test(field.label) || /name/i.test(field.name)) { const val=raPickString(data, [field.name]); if (val) return val; } } const preferred=raPickString(data, [ 'Name' , 'name' , 'full_name' , 'fullName' , 'Full Name' , 'Full_Name' , 'reporter_name' , 'Reporter Name' , 'Reporter_Name' , 'applicant_name' , 'username' , 'first_name' , 'firstName' ]); if (preferred) return preferred; const keys=Object.keys(data); for (let i=0; i < keys.length; i++) { if (/name/i.test(keys[i])) { const val=data[keys[i]]; if (typeof val==='string' && val.trim() && !raIsUrl(val) && !raIsEmail(val) && !raIsPhone(val)) return val.trim(); } } for (let i=0; i < keys.length; i++) { const val=data[keys[i]]; if (typeof val !=='string' || !val.trim() || raIsUrl(val) || raIsEmail(val) || raIsPhone(val)) continue; if (/\\.(pdf|jpg|jpeg|png|webp|gif)$/i.test(val)) continue; return val.trim(); } return 'Applicant' ; } 
function raGetEmail(data) { if (!data) return '' ; return raPickString(data, ['email', 'Email' , 'email_address' , 'Email_Address' , 'contact_email' ]) || '' ; } 
function raGetPhone(data) { if (!data) return '' ; return raPickString(data, ['mobile', 'Mobile' , 'phone' , 'Phone' , 'mobile_number' , 'Mobile_Number' , 'phone_number' , 'Phone_Number' , 'contact_number' , 'mobileNumber' ]) || '' ; }
raApps.forEach(function(app) {
    const name = raGetName(app.data);
    const email = raGetEmail(app.data);
    const phone = raGetPhone(app.data);
    const locationStr = (typeof raPickString === 'function') ? raPickString(app.data || {}, ['district', 'District', 'mandal', 'Mandal', 'village', 'Village', 'constituency', 'Constituency', 'city', 'City', 'location', 'Location']) : '';
%>
    href="/register-editor?source=application&email=<%= encodeURIComponent(email || '') %>&name=<%= encodeURIComponent(name || '') %>&mobile=<%= encodeURIComponent(phone || '') %>&location=<%= encodeURIComponent(locationStr || '') %>"
<% }); %>
`;

console.log(ejs.render(template, mockLocals));
