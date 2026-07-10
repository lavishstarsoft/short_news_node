const mongoose = require('mongoose');
const AppSettings = require('./models/AppSettings');
require('dotenv').config();

const contactUsHtml = `
  [section-title]Contact Details[/section-title]
  <p style="color: #666; font-size: 14px;">For any support / any other queries write to</p>
  
  [email-box]reach@yellowsingam.com[/email-box]
  [whatsapp-box]Open WhatsApp[/whatsapp-box]
  
  [section-title]Address[/section-title]
  [address-box]Door No. 4-105, 2nd Floor, NRI Garden Road, Mangalagiri, Guntur District, Andhra Pradesh - 522503.[/address-box]
  
  <p style="text-align: center; color: #999; font-size: 12px; margin-top: 40px;">CBN Tehelka News - COPYRIGHT 2026</p>
`;

const privacyPolicyHtml = `
  [section-title]1. Data Collection[/section-title]
  <p>We collect minimal data necessary for the app to function, such as device identifiers for personalized notifications and usage metrics to improve our content delivery.</p>
  
  [section-title]2. Location Permission[/section-title]
  <p>The app requests location access to provide localized news stories relevant to your region. You can manage this permission in your device settings at any time.</p>
  
  [section-title]3. Third-Party Services[/section-title]
  <p>We use verified third-party services like OneSignal for notifications and Google Mobile Ads. These services may collect information as per their own privacy policies.</p>
  
  [section-title]4. Data Security[/section-title]
  <p>We implement industry-standard security measures to protect your information from unauthorized access, alteration, or disclosure.</p>
  
  [section-title]5. Cookies & Local Storage[/section-title]
  <p>We use local storage on your device to save your preferences (like language) and bookmarks, ensuring a personalized experience even when offline.</p>
`;

const aboutUsHtml = `
  <p style="font-size: 16px; line-height: 1.6; margin-top: 10px;">Welcome to <strong>Tehelka News</strong> — your premium source for verified, concise, and impactful news. In a world of information overload, we bring you the facts that matter, stripped of the noise.</p>
  
  [section-title]Our Mission[/section-title]
  <p>To empower citizens with truth by delivering unbiased, fast, and 100% fact-checked journalism directly to their fingertips.</p>
  
  [section-title]Why Choose Us?[/section-title]
  <ul>
    <li><strong>Fact-Checked:</strong> Every major story goes through our rigorous verification engine.</li>
    <li><strong>Concise:</strong> News summarized beautifully so you can stay informed in under 60 seconds.</li>
    <li><strong>Dynamic:</strong> Interactive polls, live videos, and immersive gamification.</li>
  </ul>
`;

const termsHtml = `
  <p style="font-size: 16px; margin-top: 10px;">By downloading and using the app, you agree to comply with the following terms:</p>
  
  [section-title]1. Content Usage[/section-title]
  <p>All news articles, videos, and images provided in this app are our intellectual property. You may not scrape, republish, or commercialize our content without explicit written consent.</p>
  
  [section-title]2. User Conduct[/section-title]
  <p>When participating in comments or polls, you agree to maintain respectful discourse. Hate speech, misinformation, and spam will result in immediate account suspension.</p>
  
  [section-title]3. Reporter Status[/section-title]
  <p>Users applying for 'Reporter' status must provide accurate credentials. We reserve the right to revoke reporter privileges if guidelines are violated.</p>
`;

async function updatePages() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/shortnews', {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    
    let settings = await AppSettings.findOne({ key: 'update_flags' });
    if (!settings) {
      settings = new AppSettings();
    }
    
    settings.contactUs = contactUsHtml.replace(/\\n/g, '').trim();
    settings.privacyPolicy = privacyPolicyHtml.replace(/\\n/g, '').trim();
    settings.aboutUs = aboutUsHtml.replace(/\\n/g, '').trim();
    settings.termsAndConditions = termsHtml.replace(/\\n/g, '').trim();
    
    await settings.save();
    console.log('All Legal pages updated successfully with shortcodes!');
    process.exit(0);
  } catch (error) {
    console.error('Error updating pages:', error);
    process.exit(1);
  }
}

updatePages();
