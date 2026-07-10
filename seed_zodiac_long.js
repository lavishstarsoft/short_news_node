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

const dummyTexts = {
  te: `<p>ఈరోజు మీ రాశిలో చంద్రుడి సంచారం వల్ల మీలో సృజనాత్మకత మరియు కళల పట్ల ఆసక్తి పెరుగుతుంది. మీరు ఎంతో ఉత్సాహంగా ఉంటూ ఆనందం కోసం సమయాన్ని కేటాయిస్తారు. కొత్త బట్టలు లేదా నగలు కొనుగోలు చేయడానికి ఇది చాలా అనుకూలమైన సమయం. అయితే విలాసాల కోసం ఖర్చులు పెరిగే అవకాశం ఉన్నందున, డబ్బు విషయంలో కొంచెం ఆచితూచి వ్యవహరించడం మంచిది. <span style="color: rgb(230, 0, 0);">ముఖ్యంగా పెద్ద ఆర్థిక నిర్ణయాలు తీసుకునేటప్పుడు జాగ్రత్త వహించండి.</span> మరింత సమాచారం కోసం <a href="https://example.com" target="_blank">ఇక్కడ క్లిక్ చేయండి</a>.</p>`,
  en: `<p>Today, the transit of the Moon in your zodiac sign increases your creativity and interest in arts. You will be very enthusiastic and spend time seeking happiness. This is a very favorable time to buy new clothes or jewelry. However, since there is a chance of increased expenses for luxuries, it is better to be careful with money. <span style="color: rgb(230, 0, 0);">Especially when making big financial decisions, be cautious.</span> For more information <a href="https://example.com" target="_blank">click here</a>.</p>`,
  hi: `<p>आज आपकी राशि में चंद्रमा के गोचर से आपकी रचनात्मकता और कला के प्रति रुचि बढ़ेगी। आप बहुत उत्साहित रहेंगे और खुशी की तलाश में समय बिताएंगे। नए कपड़े या आभूषण खरीदने के लिए यह बहुत ही अनुकूल समय है। हालांकि, विलासिता के लिए खर्च बढ़ने की संभावना है, इसलिए पैसे के मामले में थोड़ा सावधान रहना बेहतर है। <span style="color: rgb(230, 0, 0);">खासकर बड़े आर्थिक निर्णय लेते समय सावधानी बरतें।</span> अधिक जानकारी के लिए <a href="https://example.com" target="_blank">यहां क्लिक करें</a>।</p>`,
  mr: `<p>आज तुमच्या राशीत चंद्राचे संक्रमण झाल्याने तुमची सर्जनशीलता आणि कलेची आवड वाढेल. तुम्ही खूप उत्साही असाल आणि आनंदाच्या शोधात वेळ घालवाल. नवीन कपडे किंवा दागिने खरेदी करण्यासाठी ही अत्यंत अनुकूल वेळ आहे. मात्र, चैनीच्या वस्तूंवर खर्च वाढण्याची शक्यता असल्याने पैशाच्या बाबतीत थोडी काळजी घेणे योग्य ठरेल. <span style="color: rgb(230, 0, 0);">विशेषतः मोठे आर्थिक निर्णय घेताना सावधगिरी बाळगा.</span> अधिक माहितीसाठी <a href="https://example.com" target="_blank">येथे क्लिक करा</a>.</p>`,
  mt: `<p>आज तुमच्या राशीत चंद्राचे संक्रमण झाल्याने तुमची सर्जनशीलता आणि कलेची आवड वाढेल. तुम्ही खूप उत्साही असाल आणि आनंदाच्या शोधात वेळ घालवाल. नवीन कपडे किंवा दागिने खरेदी करण्यासाठी ही अत्यंत अनुकूल वेळ आहे. मात्र, चैनीच्या वस्तूंवर खर्च वाढण्याची शक्यता असल्याने पैशाच्या बाबतीत थोडी काळजी घेणे योग्य ठरेल. <span style="color: rgb(230, 0, 0);">विशेषतः मोठे आर्थिक निर्णय घेताना सावधगिरी बाळगा.</span> अधिक माहितीसाठी <a href="https://example.com" target="_blank">येथे क्लिक करा</a>.</p>`,
  ta: `<p>இன்று உங்கள் ராசியில் சந்திரனின் சஞ்சாரம் உங்கள் படைப்பாற்றலையும் கலைகளில் ஆர்வத்தையும் அதிகரிக்கும். நீங்கள் மிகவும் உற்சாகமாக இருப்பீர்கள் மற்றும் மகிழ்ச்சிக்காக நேரத்தை செலவிடுவீர்கள். புதிய ஆடைகள் அல்லது நகைகள் வாங்க இது மிகவும் சாதகமான நேரம். எனினும் ஆடம்பர செலவுகள் அதிகரிக்க வாய்ப்புள்ளதால், பண விஷயத்தில் சற்று கவனமாக இருப்பது நல்லது. <span style="color: rgb(230, 0, 0);">குறிப்பாக பெரிய நிதி முடிவுகளை எடுக்கும் போது எச்சரிக்கையாக இருங்கள்.</span> மேலும் தகவலுக்கு <a href="https://example.com" target="_blank">இங்கே கிளிக் செய்யவும்</a>.</p>`
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

const defaultResultTitleFormats = {
  te: "{sign} రాశి ఫలితాలు ({date})",
  en: "{sign} Horoscope ({date})",
  hi: "{sign} राशिफल ({date})",
  mr: "{sign} राशीभविष्य ({date})",
  mt: "{sign} राशीभविष्य ({date})",
  ta: "{sign} ராசி பலன் ({date})"
};


mongoose.connect(process.env.MONGODB_URI).then(async () => {
  try {
    const langs = await Language.find({ isActive: true });
    const date = '2026-07-10';
    
    for (const langObj of langs) {
      const code = langObj.code;
      const signsNames = defaultSigns[code] || defaultSigns['en'];
      const textTemplate = dummyTexts[code] || dummyTexts['en'];
      
      const signsArray = signsNames.map((name, index) => {
        return {
          signId: (index + 1).toString(),
          name: name,
          result: textTemplate
        };
      });

      const existing = await ZodiacDaily.findOne({ date, language: code });
      if (existing) {
        existing.chooseTitle = defaultChooseTitles[code] || defaultChooseTitles['en'];
        existing.knowTitle = defaultKnowTitles[code] || defaultKnowTitles['en'];
        existing.resultTitleFormat = defaultResultTitleFormats[code] || defaultResultTitleFormats['en'];
        existing.signs = signsArray;
        await existing.save();
        console.log(`Updated zodiac for ${code} on ${date}`);
      } else {
        const newZodiac = new ZodiacDaily({
          date,
          language: code,
          chooseTitle: defaultChooseTitles[code] || defaultChooseTitles['en'],
          knowTitle: defaultKnowTitles[code] || defaultKnowTitles['en'],
          resultTitleFormat: defaultResultTitleFormats[code] || defaultResultTitleFormats['en'],
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
