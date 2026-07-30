const app = { data: {
  "experience": "10",
  "Location": "Lalitpur (UP)",
  "Name": "Neeraj Kumar",
  "Father": "Keshav Das",
  "phone_number": "7355975248",
  "Alternate Mobile": "7355975248",
  "email": "snblalitpur@gmail.com",
  "REFERRED_BY": "Asraf Ansari",
  "Aadhar": "https://media.yellowsingam.com/short_news_images/4e7af0d60d37abbe559b6bb8a4907f5f.webp",
  "Aadhar_Back": "https://media.yellowsingam.com/short_news_images/afeffcae531a60a6cb2dbb2da2103fed.webp",
  "Pass Photo": "https://media.yellowsingam.com/short_news_images/98757dec3770e2e1128a3aaf2eb18c5d.webp"
} };

const raRegFields = [];

function raIsUrl(value) { return typeof value==='string' && (value.startsWith('http') || value.startsWith('/uploads') || value.includes('pub-')); } 
function raIsEmail(value) { return typeof value==='string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()); } 
function raIsPhone(value) { return typeof value==='string' && /^\+?[\d\s()-]{8,}$/.test(value.replace(/\s/g, '' )); }
function raPickString(data, keys) { if (!data) return ''; for (let i=0; i < keys.length; i++) { const val=data[keys[i]]; if (val && typeof val==='string' && val.trim() && !raIsUrl(val)) return val.trim(); } return '' ; } 
function raGetName(data) { if (!data || typeof data !=='object' ) return 'Applicant' ; for (let i=0; i < raRegFields.length; i++) { const field=raRegFields[i]; if (/name/i.test(field.label) || /name/i.test(field.name)) { const val=raPickString(data, [field.name]); if (val) return val; } } const preferred=raPickString(data, [ 'Name' , 'name' , 'full_name' , 'fullName' , 'Full Name' , 'Full_Name' , 'reporter_name' , 'Reporter Name' , 'Reporter_Name' , 'applicant_name' , 'username' , 'first_name' , 'firstName' ]); if (preferred) return preferred; const keys=Object.keys(data); for (let i=0; i < keys.length; i++) { if (/name/i.test(keys[i])) { const val=data[keys[i]]; if (typeof val==='string' && val.trim() && !raIsUrl(val) && !raIsEmail(val) && !raIsPhone(val)) return val.trim(); } } for (let i=0; i < keys.length; i++) { const val=data[keys[i]]; if (typeof val !=='string' || !val.trim() || raIsUrl(val) || raIsEmail(val) || raIsPhone(val)) continue; if (/\.(pdf|jpg|jpeg|png|webp|gif)$/i.test(val)) continue; return val.trim(); } return 'Applicant' ; } 
function raGetEmail(data) { if (!data) return '' ; return raPickString(data, ['email', 'Email' , 'email_address' , 'Email_Address' , 'contact_email' ]) || '' ; } 
function raGetPhone(data) { if (!data) return '' ; return raPickString(data, ['mobile', 'Mobile' , 'phone' , 'Phone' , 'mobile_number' , 'Mobile_Number' , 'phone_number' , 'Phone_Number' , 'contact_number' , 'mobileNumber' ]) || '' ; }

console.log("email:", raGetEmail(app.data));
console.log("phone:", raGetPhone(app.data));
