'use strict';

/**
 * Cross-script place search: reporters type a place name in their own script
 * (Hindi/Devanagari, Telugu…) but the LGD geo data stores names in ENGLISH.
 *
 * We can't transliterate exactly (schwa deletion, v/w, ph/f… make it fuzzy), so
 * instead we reduce the typed word to its CONSONANT skeleton and match English
 * names whose consonants line up — vowels in between are allowed to differ.
 *   बालोतरा → b l t r  →  /^b[..]*l[..]*t[..]*r/  → matches "balotra".
 *
 * This is ADDITIVE: it is used only when the query is in an Indic script. A
 * Latin (English) query keeps the old exact prefix match untouched.
 */

// Each Indic consonant → a small Roman regex fragment (fuzzy where English is
// inconsistent). Vowels, matras, anusvara, virama, nukta etc. are dropped.
const CONSONANTS = {
  // ── Devanagari (Hindi / Marathi) ──
  'क': 'k', 'ख': 'kh?', 'ग': 'g', 'घ': 'gh?', 'ङ': 'n',
  'च': 'ch?', 'छ': 'ch?h?', 'ज': '[jz]', 'झ': 'jh?', 'ञ': 'ny?',
  'ट': 't', 'ठ': 'th?', 'ड': '[dr]', 'ढ': 'dh?', 'ण': 'n',
  'त': 't', 'थ': 'th?', 'द': 'd', 'ध': 'dh?', 'न': 'n',
  'प': 'p', 'फ': '[pf]h?', 'ब': 'b', 'भ': 'bh?', 'म': 'm',
  'य': 'y?', 'र': 'r', 'ल': 'l', 'व': '[vw]?', 'ळ': 'l',
  'श': 'sh?', 'ष': 'sh?', 'स': 's', 'ह': 'h?',
  'क़': 'k', 'ख़': 'kh?', 'ग़': 'g', 'ज़': '[jz]', 'ड़': 'r', 'ढ़': 'rh?', 'फ़': 'f', 'य़': 'y?',
  // nasal marks (anusvara / chandrabindu) read as an optional 'n'
  'ं': 'n?', 'ँ': 'n?',
  // ── Telugu ──
  'క': 'k', 'ఖ': 'kh?', 'గ': 'g', 'ఘ': 'gh?', 'ఙ': 'n',
  'చ': 'ch?', 'ఛ': 'ch?h?', 'జ': '[jz]', 'ఝ': 'jh?', 'ఞ': 'ny?',
  'ట': 't', 'ఠ': 'th?', 'డ': '[dr]', 'ఢ': 'dh?', 'ణ': 'n',
  'త': 't', 'థ': 'th?', 'ద': 'd', 'ధ': 'dh?', 'న': 'n',
  'ప': 'p', 'ఫ': '[pf]h?', 'బ': 'b', 'భ': 'bh?', 'మ': 'm',
  'య': 'y?', 'ర': 'r', 'ఱ': 'r', 'ల': 'l', 'ళ': 'l', 'వ': '[vw]?',
  'శ': 'sh?', 'ష': 'sh?', 'స': 's', 'హ': 'h?',
  'ం': 'n?', 'ఁ': 'n?',
  // ── Gurmukhi (Punjabi) ──
  'ਕ': 'k', 'ਖ': 'kh?', 'ਗ': 'g', 'ਘ': 'gh?', 'ਙ': 'n',
  'ਚ': 'ch?', 'ਛ': 'ch?h?', 'ਜ': '[jz]', 'ਝ': 'jh?', 'ਞ': 'ny?',
  'ਟ': 't', 'ਠ': 'th?', 'ਡ': '[dr]', 'ਢ': 'dh?', 'ਣ': 'n',
  'ਤ': 't', 'ਥ': 'th?', 'ਦ': 'd', 'ਧ': 'dh?', 'ਨ': 'n',
  'ਪ': 'p', 'ਫ': '[pf]h?', 'ਬ': 'b', 'ਭ': 'bh?', 'ਮ': 'm',
  'ਯ': 'y?', 'ਰ': 'r', 'ਲ': 'l', 'ਵ': '[vw]?', 'ੜ': 'r',
  'ਸ': 's', 'ਸ਼': 'sh?', 'ਹ': 'h?', 'ਖ਼': 'kh?', 'ਗ਼': 'g', 'ਜ਼': '[jz]', 'ਫ਼': 'f', 'ਲ਼': 'l',
  'ਂ': 'n?', 'ੰ': 'n?', 'ਁ': 'n?',
  // ── Gujarati ──
  'ક': 'k', 'ખ': 'kh?', 'ગ': 'g', 'ઘ': 'gh?', 'ઙ': 'n',
  'ચ': 'ch?', 'છ': 'ch?h?', 'જ': '[jz]', 'ઝ': 'jh?', 'ઞ': 'ny?',
  'ટ': 't', 'ઠ': 'th?', 'ડ': '[dr]', 'ઢ': 'dh?', 'ણ': 'n',
  'ત': 't', 'થ': 'th?', 'દ': 'd', 'ધ': 'dh?', 'ન': 'n',
  'પ': 'p', 'ફ': '[pf]h?', 'બ': 'b', 'ભ': 'bh?', 'મ': 'm',
  'ય': 'y?', 'ર': 'r', 'લ': 'l', 'ળ': 'l', 'વ': '[vw]?',
  'શ': 'sh?', 'ષ': 'sh?', 'સ': 's', 'હ': 'h?', 'ં': 'n?', 'ઁ': 'n?',
  // ── Tamil (fewer consonants; many are ambiguous k/g, t/d, p/b) ──
  'க': '[kg]', 'ங': 'n', 'ச': '[csj]h?', 'ஞ': 'ny?',
  'ட': '[dt]', 'ண': 'n', 'த': '[dt]h?', 'ந': 'n', 'ன': 'n',
  'ப': '[pb]', 'ம': 'm', 'ய': 'y?', 'ர': 'r', 'ற': 'r',
  'ல': 'l', 'ள': 'l', 'ழ': '[lz]h?', 'வ': '[vw]?',
  'ஶ': 'sh?', 'ஷ': 'sh?', 'ஸ': 's', 'ஹ': 'h?', 'ஜ': '[jz]',
  // ── Urdu (Arabic script; short vowels usually omitted) ──
  'ب': 'b', 'پ': 'p', 'ت': 't', 'ٹ': 't', 'ث': 's', 'ج': '[jz]', 'چ': 'ch?',
  'ح': 'h?', 'خ': 'kh?', 'د': 'd', 'ڈ': 'd', 'ذ': 'z', 'ر': 'r', 'ڑ': 'r',
  'ز': 'z', 'ژ': '[jz]', 'س': 's', 'ش': 'sh?', 'ص': 's', 'ض': 'z', 'ط': 't',
  'ظ': 'z', 'غ': 'gh?', 'ف': 'f', 'ق': '[kq]', 'ك': 'k', 'ک': 'k', 'گ': 'g',
  'ل': 'l', 'م': 'm', 'ن': 'n', 'ں': 'n?', 'و': '[vw]?', 'ہ': 'h?', 'ھ': 'h?',
  'ۃ': 'h?', 'ه': 'h?', 'ی': 'y?', 'ے': 'y?', 'ي': 'y?',
};

// Arabic/Urdu, Devanagari (Hindi/Marathi), Gurmukhi (Punjabi), Gujarati,
// Tamil, Telugu blocks.
const INDIC_RE = /[؀-ۿऀ-ॿ਀-૿஀-௿ఀ-౿]/;

function isIndic(str) {
  return INDIC_RE.test(String(str || ''));
}

/** Ordered list of Roman consonant fragments for an Indic word (vowels dropped). */
function consonantFragments(str) {
  const out = [];
  for (const ch of String(str || '')) {
    const frag = CONSONANTS[ch];
    if (frag) out.push(frag);
  }
  return out;
}

/**
 * Build a tolerant regex that matches an English name sharing the typed word's
 * consonant skeleton. Returns null when there aren't enough consonants to be
 * safe (avoids matching half the district on a 1-letter query).
 */
function indicNameRegex(str) {
  const frags = consonantFragments(str);
  if (frags.length < 2) return null; // need at least 2 consonants to be useful
  // A leading vowel-carrier (alif / independent अ / અ) is dropped from the
  // skeleton, but the English name may still START with that vowel (e.g. Urdu
  // "اننت" → English "anantnag"). So allow an optional leading vowel. Then
  // vowels and semivowel glides (y/w/h) between consonants may differ.
  return "^[aeiou]*" + frags.join("[aeiouywh\\s'-]*");
}

module.exports = { isIndic, indicNameRegex, consonantFragments };
