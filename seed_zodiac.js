require('dotenv').config();
const mongoose = require('mongoose');
const ZodiacDaily = require('./models/ZodiacDaily');
const Language = require('./models/Language');

const defaultSigns = {
  te: ["మేషం", "వృషభం", "మిథునం", "కర్కాటకం", "సింహం", "కన్య", "తుల", "వృశ్చికం", "ధనుస్సు", "మకరం", "కుంభం", "మీనం"],
  en: ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo", "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces"],
  hi: ["मेष", "वृषभ", "मिथुन", "कर्क", "सिंह", "कन्या", "तुला", "वृश्चिक", "धनु", "मकर", "कुंभ", "मीन"],
  mr: ["मेष", "वृषभ", "मिथुन", "कर्क", "सिंह", "कन्या", "तूळ", "वृश्चिक", "धनु", "मकर", "कुंभ", "मीन"],
  mt: ["मेष", "वृषभ", "मिथुन", "कर्क", "सिंह", "कन्या", "तूळ", "वृश्चिक", "धनु", "मकर", "कुंभ", "मीन"],
  ta: ["மேஷம்", "ரிஷபம்", "மிதுனம்", "கடகம்", "சிம்மம்", "கன்னி", "துலாம்", "விருச்சிகம்", "தனுசு", "மகரம்", "கும்பம்", "மீனம்"]
};

const defaultChooseTitles = {
  te: "మీ రాశిని ఎంచుకోండి",
  en: "Choose your zodiac sign",
  hi: "अपनी राशि चुनें",
  mr: "तुमची रास निवडा",
  mt: "तुमची रास निवडा",
  ta: "உங்கள் ராசியைத் தேர்ந்தெடுக்கவும்"
};

const defaultKnowTitles = {
  te: "మీ రాశి తెలుసుకోండి",
  en: "Know your zodiac sign",
  hi: "अपनी राशि जानें",
  mr: "तुमची रास जाणून घ्या",
  mt: "तुमची रास जाणून घ्या",
  ta: "உங்கள் ராசியை அறியுங்கள்"
};

// Dummy text generators with Rich HTML (colors and links)
const generateResult = (lang, signName, index) => {
  const variations = [
    { type: 'Financial', color: 'rgb(0, 138, 0)' },
    { type: 'Health', color: 'rgb(230, 0, 0)' },
    { type: 'Career', color: 'rgb(0, 102, 204)' },
    { type: 'Family', color: 'rgb(102, 51, 255)' },
    { type: 'Education', color: 'rgb(204, 102, 0)' },
    { type: 'Travel', color: 'rgb(0, 153, 153)' },
    { type: 'Business', color: 'rgb(153, 0, 153)' },
    { type: 'Love', color: 'rgb(204, 0, 102)' },
    { type: 'Spiritual', color: 'rgb(102, 102, 102)' },
    { type: 'Social', color: 'rgb(153, 153, 0)' },
    { type: 'Property', color: 'rgb(0, 51, 102)' },
    { type: 'Luck', color: 'rgb(255, 153, 51)' }
  ];
  
  const v = variations[index % 12];
  
  if (lang === 'te') {
    return `<p>ఈ రోజు <strong>${signName}</strong> రాశి వారికి ${v.type} పరంగా చాలా అనుకూలంగా ఉంటుంది. <span style="color: ${v.color};">మంచి ఫలితాలు రావచ్చు.</span> మరిన్ని వివరాలకు <a href="https://example.com/telugu-${v.type.toLowerCase()}" target="_blank">ఇక్కడ క్లిక్ చేయండి</a>.</p>`;
  } else if (lang === 'hi') {
    return `<p>आज <strong>${signName}</strong> राशि के लोगों के लिए ${v.type} के मामले में दिन बहुत शुभ है। <span style="color: ${v.color};">सकारात्मक परिणाम मिल सकते हैं।</span> अधिक जानकारी के लिए <a href="https://example.com/hindi-${v.type.toLowerCase()}" target="_blank">यहाँ क्लिक करें</a>।</p>`;
  } else if (lang === 'mr' || lang === 'mt') {
    return `<p>आजचा दिवस <strong>${signName}</strong> राशीच्या लोकांसाठी ${v.type} च्या बाबतीत खूप शुभ आहे. <span style="color: ${v.color};">चांगले परिणाम मिळू शकतात.</span> अधिक माहितीसाठी <a href="https://example.com/marathi-${v.type.toLowerCase()}" target="_blank">येथे क्लिक करा</a>.</p>`;
  } else if (lang === 'ta') {
    return `<p>இன்று <strong>${signName}</strong> ராசிக்காரர்களுக்கு ${v.type} ரீதியாக மிகவும் உகந்த நாள். <span style="color: ${v.color};">நல்ல பலன்கள் கிடைக்கும்.</span> மேலும் அறிய <a href="https://example.com/tamil-${v.type.toLowerCase()}" target="_blank">இங்கே கிளிக் செய்யவும்</a>.</p>`;
  } else {
    // English default
    return `<p>Today is a very favorable day for <strong>${signName}</strong> in terms of ${v.type}. <span style="color: ${v.color};">You may experience positive outcomes.</span> For more details, <a href="https://example.com/english-${v.type.toLowerCase()}" target="_blank">click here</a>.</p>`;
  }
};

mongoose.connect(process.env.MONGODB_URI).then(async () => {
  try {
    const langs = await Language.find({ isActive: true });
    const date = '2026-07-10';
    
    for (const langObj of langs) {
      const code = langObj.code;
      const signsNames = defaultSigns[code] || defaultSigns['en'];
      
      const signsArray = signsNames.map((name, index) => {
        return {
          signId: (index + 1).toString(),
          name: name,
          result: generateResult(code, name, index)
        };
      });

      const existing = await ZodiacDaily.findOne({ date, language: code });
      if (existing) {
        existing.chooseTitle = defaultChooseTitles[code] || defaultChooseTitles['en'];
        existing.knowTitle = defaultKnowTitles[code] || defaultKnowTitles['en'];
        existing.signs = signsArray;
        await existing.save();
        console.log(`Updated zodiac for ${code} on ${date}`);
      } else {
        const newZodiac = new ZodiacDaily({
          date,
          language: code,
          chooseTitle: defaultChooseTitles[code] || defaultChooseTitles['en'],
          knowTitle: defaultKnowTitles[code] || defaultKnowTitles['en'],
          signs: signsArray
        });
        await newZodiac.save();
        console.log(`Inserted zodiac for ${code} on ${date}`);
      }
    }
    
    console.log('Seeding completed successfully!');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
});
