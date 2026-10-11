// panchangService.js — FREE, self-hosted Panchangam engine.
// Astronomy from mhah-panchang (tithi/nakshatra/yoga/karana/masa/moon-raasi, verified
// against Drik Panchang) + suncalc (sunrise/sunset). Rahukalam/Yamagandam/Gulika/
// Abhijit/Brahma muhurtam are derived from sunrise–sunset by the standard fixed-segment
// formulas. No API key, no network, no cost. Additive-only; nothing else depends on it.
//
// NOT computed here (need finer ephemeris — Phase 2): Varjyam, Amritakalam, Durmuhurtam.

const SunCalc = require('suncalc');
let MhahPanchang;
try {
  MhahPanchang = require('mhah-panchang').MhahPanchang;
} catch (e) {
  MhahPanchang = null;
}

const IST_MS = 5.5 * 3600000;

// ---- Name tables (indexed by the lib's `ino`) -----------------------------
const TITHI = {
  te: ['పాడ్యమి','విదియ','తదియ','చవితి','పంచమి','షష్టి','సప్తమి','అష్టమి','నవమి','దశమి','ఏకాదశి','ద్వాదశి','త్రయోదశి','చతుర్దశి','పౌర్ణమి',
       'పాడ్యమి','విదియ','తదియ','చవితి','పంచమి','షష్టి','సప్తమి','అష్టమి','నవమి','దశమి','ఏకాదశి','ద్వాదశి','త్రయోదశి','చతుర్దశి','అమావాస్య'],
  hi: ['प्रतिपदा','द्वितीया','तृतीया','चतुर्थी','पंचमी','षष्ठी','सप्तमी','अष्टमी','नवमी','दशमी','एकादशी','द्वादशी','त्रयोदशी','चतुर्दशी','पूर्णिमा',
       'प्रतिपदा','द्वितीया','तृतीया','चतुर्थी','पंचमी','षष्ठी','सप्तमी','अष्टमी','नवमी','दशमी','एकादशी','द्वादशी','त्रयोदशी','चतुर्दशी','अमावस्या'],
  en: ['Padyami','Vidiya','Tadiya','Chaviti','Panchami','Shashti','Saptami','Ashtami','Navami','Dasami','Ekadasi','Dwadasi','Trayodasi','Chaturdasi','Pournami',
       'Padyami','Vidiya','Tadiya','Chaviti','Panchami','Shashti','Saptami','Ashtami','Navami','Dasami','Ekadasi','Dwadasi','Trayodasi','Chaturdasi','Amavasya'],
};
const PAKSHA = {
  te: { Shukla: 'శుక్ల పక్షం', Krishna: 'బహుళ (కృష్ణ) పక్షం' },
  hi: { Shukla: 'शुक्ल पक्ष', Krishna: 'कृष्ण पक्ष' },
  en: { Shukla: 'Shukla Paksha', Krishna: 'Krishna Paksha' },
};
const NAK = {
  te: ['అశ్విని','భరణి','కృత్తిక','రోహిణి','మృగశిర','ఆరుద్ర','పునర్వసు','పుష్యమి','ఆశ్లేష','మఖ','పుబ్బ','ఉత్తర','హస్త','చిత్త','స్వాతి','విశాఖ','అనూరాధ','జ్యేష్ఠ','మూల','పూర్వాషాఢ','ఉత్తరాషాఢ','శ్రవణం','ధనిష్ఠ','శతభిషం','పూర్వాభాద్ర','ఉత్తరాభాద్ర','రేవతి'],
  hi: ['अश्विनी','भरणी','कृत्तिका','रोहिणी','मृगशिरा','आर्द्रा','पुनर्वसु','पुष्य','आश्लेषा','मघा','पूर्वाफाल्गुनी','उत्तराफाल्गुनी','हस्त','चित्रा','स्वाति','विशाखा','अनुराधा','ज्येष्ठा','मूल','पूर्वाषाढ़ा','उत्तराषाढ़ा','श्रवण','धनिष्ठा','शतभिषा','पूर्वाभाद्रपद','उत्तराभाद्रपद','रेवती'],
  en: ['Ashwini','Bharani','Krittika','Rohini','Mrigasira','Ardra','Punarvasu','Pushyami','Aslesha','Magha','Pubba','Uttara','Hasta','Chitta','Swati','Visakha','Anuradha','Jyeshta','Mula','Purvashada','Uttarashada','Sravanam','Dhanishta','Satabhisham','Purvabhadra','Uttarabhadra','Revati'],
};
const YOGA = {
  te: ['విష్కంభం','ప్రీతి','ఆయుష్మాన్','సౌభాగ్యం','శోభనం','అతిగండం','సుకర్మ','ధృతి','శూలం','గండం','వృద్ధి','ధ్రువం','వ్యాఘాతం','హర్షణం','వజ్రం','సిద్ధి','వ్యతీపాతం','వరీయాన్','పరిఘం','శివం','సిద్ధం','సాధ్యం','శుభం','శుక్లం','బ్రహ్మ','ఇంద్రం','వైధృతి'],
  hi: ['विष्कम्भ','प्रीति','आयुष्मान','सौभाग्य','शोभन','अतिगण्ड','सुकर्मा','धृति','शूल','गण्ड','वृद्धि','ध्रुव','व्याघात','हर्षण','वज्र','सिद्धि','व्यतीपात','वरीयान','परिघ','शिव','सिद्ध','साध्य','शुभ','शुक्ल','ब्रह्म','ऐन्द्र','वैधृति'],
  en: ['Vishkambha','Priti','Ayushman','Saubhagya','Sobhana','Atiganda','Sukarma','Dhriti','Soola','Ganda','Vriddhi','Dhruva','Vyaghata','Harshana','Vajra','Siddhi','Vyatipata','Variyan','Parigha','Siva','Siddha','Sadhya','Subha','Sukla','Brahma','Indra','Vaidhriti'],
};
const KARANA = {
  te: ['బవ','బాలవ','కౌలవ','తైతిల','గరజ','వణిజ','విష్టి (భద్ర)','శకుని','చతుష్పాద','నాగవ','కింస్తుఘ్న'],
  hi: ['बव','बालव','कौलव','तैतिल','गर','वणिज','विष्टि (भद्रा)','शकुनि','चतुष्पाद','नाग','किंस्तुघ्न'],
  en: ['Bava','Balava','Kaulava','Taitila','Garaja','Vanija','Vishti (Bhadra)','Sakuni','Chatushpada','Naga','Kimstughna'],
};
const RAASI = {
  te: ['మేషం','వృషభం','మిథునం','కర్కాటకం','సింహం','కన్య','తుల','వృశ్చికం','ధనుస్సు','మకరం','కుంభం','మీనం'],
  hi: ['मेष','वृषभ','मिथुन','कर्क','सिंह','कन्या','तुला','वृश्चिक','धनु','मकर','कुम्भ','मीन'],
  en: ['Mesha','Vrishabha','Mithuna','Karkataka','Simha','Kanya','Tula','Vrischika','Dhanassu','Makara','Kumbha','Meena'],
};
const MASA = { // lib ino order: 0 Baisakha ... 11 Chaitra
  te: ['వైశాఖ','జ్యేష్ఠ','ఆషాఢ','శ్రావణ','భాద్రపద','ఆశ్వయుజ','కార్తీక','మార్గశిర','పుష్య','మాఘ','ఫాల్గుణ','చైత్ర'],
  hi: ['वैशाख','ज्येष्ठ','आषाढ़','श्रावण','भाद्रपद','आश्विन','कार्तिक','मार्गशीर्ष','पौष','माघ','फाल्गुन','चैत्र'],
  en: ['Vaishakha','Jyeshta','Ashada','Sravana','Bhadrapada','Ashwayuja','Kartika','Margasira','Pushya','Magha','Phalguna','Chaitra'],
};
// ritu by masa ino
const RITU_BY_MASA = [0,1,1,2,2,3,3,4,4,5,5,0]; // 0 Vasanta..5 Shishira
const RITU = {
  te: ['వసంత ఋతువు','గ్రీష్మ ఋతువు','వర్ష ఋతువు','శరద్ ఋతువు','హేమంత ఋతువు','శిశిర ఋతువు'],
  hi: ['वसंत ऋतु','ग्रीष्म ऋतु','वर्षा ऋतु','शरद ऋतु','हेमंत ऋतु','शिशिर ऋतु'],
  en: ['Vasanta Ritu','Grishma Ritu','Varsha Ritu','Sharad Ritu','Hemanta Ritu','Shishira Ritu'],
};
const VARA = {
  te: ['ఆదివారం','సోమవారం','మంగళవారం','బుధవారం','గురువారం','శుక్రవారం','శనివారం'],
  hi: ['रविवार','सोमवार','मंगलवार','बुधवार','गुरुवार','शुक्रवार','शनिवार'],
  en: ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'],
};
// Telugu 60-year samvatsara cycle, index 0 = Prabhava (Ugadi of 1987).
const SAMVATSARA = {
  te: ['ప్రభవ','విభవ','శుక్ల','ప్రమోదూత','ప్రజోత్పత్తి','ఆంగీరస','శ్రీముఖ','భావ','యువ','ధాత','ఈశ్వర','బహుధాన్య','ప్రమాది','విక్రమ','వృష','చిత్రభాను','స్వభాను','తారణ','పార్థివ','వ్యయ','సర్వజిత్తు','సర్వధారి','విరోధి','వికృతి','ఖర','నందన','విజయ','జయ','మన్మథ','దుర్ముఖి','హేవిళంబి','విళంబి','వికారి','శార్వరి','ప్లవ','శుభకృతు','శోభకృతు','క్రోధి','విశ్వావసు','పరాభవ','ప్లవంగ','కీలక','సౌమ్య','సాధారణ','విరోధికృతు','పరీధావి','ప్రమాదీచ','ఆనంద','రాక్షస','నల','పింగళ','కాళయుక్తి','సిద్ధార్థి','రౌద్రి','దుర్మతి','దుందుభి','రుధిరోద్గారి','రక్తాక్షి','క్రోధన','అక్షయ'],
};

// ---- time helpers (everything in IST) -------------------------------------
function istParts(dateUtc) {
  const t = new Date(dateUtc.getTime() + IST_MS);
  return { h: t.getUTCHours(), m: t.getUTCMinutes(), ms: t.getTime() };
}
function fmtTime(dateUtc, lang) {
  if (!dateUtc || isNaN(dateUtc.getTime())) return '';
  const { h, m } = istParts(dateUtc);
  const mm = String(m).padStart(2, '0');
  let h12 = h % 12; if (h12 === 0) h12 = 12;
  if (lang === 'en') {
    const ap = h < 12 ? 'AM' : 'PM';
    return `${h12}:${mm} ${ap}`;
  }
  // te/hi period words: 4-11 morning, 12-15 midday, 16-18 evening, else night
  let pTe, pHi;
  if (h >= 4 && h < 12) { pTe = 'ఉ.'; pHi = 'प्रा.'; }
  else if (h >= 12 && h < 16) { pTe = 'మ.'; pHi = 'दो.'; }
  else if (h >= 16 && h < 19) { pTe = 'సా.'; pHi = 'सायं'; }
  else { pTe = 'రా.'; pHi = 'रा.'; }
  const pre = lang === 'hi' ? pHi : pTe;
  return `${pre} ${h12}.${mm}`;
}
function addMin(dateUtc, min) { return new Date(dateUtc.getTime() + min * 60000); }

// Rahukalam / Yamagandam / Gulika — 1/8th day segments, index by weekday (0=Sun..6=Sat)
const RAHU_IDX = [7, 1, 6, 4, 5, 3, 2];
const YAMA_IDX = [4, 3, 2, 1, 0, 6, 5];
const GULI_IDX = [6, 5, 4, 3, 2, 1, 0];
function segment(sunrise, sunset, idx) {
  const part = (sunset.getTime() - sunrise.getTime()) / 8;
  return {
    start: new Date(sunrise.getTime() + idx * part),
    end: new Date(sunrise.getTime() + (idx + 1) * part),
  };
}

function pick(table, ino, lang) {
  const arr = table[lang] || table.te;
  return arr[ino] != null ? arr[ino] : (table.te[ino] || '');
}

// Which Telugu samvatsara for the solar/lunar year containing this Gregorian date.
// Telugu year rolls at Ugadi (~late March/April). Approximate with April boundary.
function samvatsara(dateUtc, lang) {
  const t = new Date(dateUtc.getTime() + IST_MS);
  let y = t.getUTCFullYear();
  if (t.getUTCMonth() < 3) y -= 1; // Jan–Mar belongs to the previous Telugu year
  const idx = (((y - 1987) % 60) + 60) % 60;
  return (SAMVATSARA[lang] || SAMVATSARA.te)[idx] || '';
}

function elementWithTimes(el, table, lang) {
  if (!el) return null;
  return {
    name: pick(table, el.ino, lang),
    start: el.start ? fmtTime(new Date(el.start), lang) : '',
    end: el.end ? fmtTime(new Date(el.end), lang) : '',
  };
}

/**
 * dayPanchang(dateUtc, lat, lng, lang) → full panchangam for a single day.
 * dateUtc: any JS Date within the target IST day. lat/lng: observer. lang: te|hi|en.
 */
function dayPanchang(dateUtc, lat, lng, lang = 'te') {
  if (!MhahPanchang) throw new Error('mhah-panchang not available');
  const o = new MhahPanchang();
  // Anchor calculations to local noon so we read the tithi/nakshatra that "owns" the day.
  const t = new Date(dateUtc.getTime() + IST_MS);
  const noonUtc = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 12 - 5, 30)); // 12:00 IST
  const c = o.calculate(noonUtc);
  let cal = {};
  try { cal = o.calendar(noonUtc, lat, lng) || {}; } catch (e) { cal = {}; }

  const times = SunCalc.getTimes(noonUtc, lat, lng);
  const sunrise = times.sunrise, sunset = times.sunset;
  const weekday = new Date(noonUtc.getTime() + IST_MS).getUTCDay();

  const rahu = segment(sunrise, sunset, RAHU_IDX[weekday]);
  const yama = segment(sunrise, sunset, YAMA_IDX[weekday]);
  const guli = segment(sunrise, sunset, GULI_IDX[weekday]);
  const dayLen = sunset.getTime() - sunrise.getTime();
  const abhiStart = new Date(sunrise.getTime() + (7 / 15) * dayLen);
  const abhiEnd = new Date(sunrise.getTime() + (8 / 15) * dayLen);
  const brahmaStart = addMin(sunrise, -96);
  const brahmaEnd = addMin(sunrise, -48);

  const masaIno = cal.Masa ? cal.Masa.ino : null;
  return {
    date: new Date(noonUtc.getTime() + IST_MS).toISOString().slice(0, 10),
    lang,
    vara: VARA[lang] ? VARA[lang][weekday] : VARA.te[weekday],
    samvatsara: samvatsara(noonUtc, lang),
    masa: masaIno != null ? pick(MASA, masaIno, lang) : '',
    ritu: masaIno != null ? (RITU[lang] || RITU.te)[RITU_BY_MASA[masaIno]] : '',
    paksha: c.Paksha ? (PAKSHA[lang] || PAKSHA.te)[c.Paksha.name_en_IN] || '' : '',
    tithi: elementWithTimes(c.Tithi, TITHI, lang),
    nakshatra: elementWithTimes(c.Nakshatra, NAK, lang),
    yoga: elementWithTimes(c.Yoga, YOGA, lang),
    karana: c.Karna ? { name: pick(KARANA, c.Karna.ino, lang) } : null,
    moonRaasi: c.Raasi ? pick(RAASI, c.Raasi.ino, lang) : '',
    sunrise: fmtTime(sunrise, lang),
    sunset: fmtTime(sunset, lang),
    auspicious: {
      abhijit: { start: fmtTime(abhiStart, lang), end: fmtTime(abhiEnd, lang) },
      brahmaMuhurta: { start: fmtTime(brahmaStart, lang), end: fmtTime(brahmaEnd, lang) },
    },
    inauspicious: {
      rahukalam: { start: fmtTime(rahu.start, lang), end: fmtTime(rahu.end, lang) },
      yamagandam: { start: fmtTime(yama.start, lang), end: fmtTime(yama.end, lang) },
      gulika: { start: fmtTime(guli.start, lang), end: fmtTime(guli.end, lang) },
    },
  };
}

/**
 * monthPanchang(year, month1to12, lat, lng, lang) → array of daily tithi lines for a
 * Gregorian month grid. Lightweight (one calc per day, no muhurta math).
 */
function monthPanchang(year, month, lat, lng, lang = 'te') {
  if (!MhahPanchang) throw new Error('mhah-panchang not available');
  const o = new MhahPanchang();
  const days = new Date(year, month, 0).getDate(); // month is 1-based here
  const out = [];
  for (let d = 1; d <= days; d++) {
    const noonUtc = new Date(Date.UTC(year, month - 1, d, 12 - 5, 30));
    const c = o.calculate(noonUtc);
    const tithi = c.Tithi ? {
      name: pick(TITHI, c.Tithi.ino, lang),
      end: c.Tithi.end ? fmtTime(new Date(c.Tithi.end), lang) : '',
      isAmavasya: c.Tithi.ino === 29,
      isPournami: c.Tithi.ino === 14,
    } : null;
    out.push({
      date: d,
      weekday: new Date(year, month - 1, d).getDay(),
      paksha: c.Paksha ? (PAKSHA[lang] || PAKSHA.te)[c.Paksha.name_en_IN] || '' : '',
      tithi,
      nakshatra: c.Nakshatra ? pick(NAK, c.Nakshatra.ino, lang) : '',
    });
  }
  return { year, month, lang, days: out };
}

module.exports = { dayPanchang, monthPanchang };
