'use strict';

/**
 * uploadValidator — dependency-free upload security inspection (Phase-2, Priority 1).
 *
 * Given the raw buffer + client-declared filename/mimetype, it:
 *   - detects the TRUE type from magic bytes (file signature),
 *   - rejects disguised executables / scripts (PE, ELF, Mach-O, shebang, PHP,
 *     HTML/JS, SVG-with-script),
 *   - flags extension/mime mismatch and dangerous / double extensions,
 * and returns a verdict. It NEVER mutates the buffer and NEVER throws to the caller
 * (callers still wrap it). Enforcement is decided by the caller (alert-only default).
 *
 * Note: uploaded files are stored on object storage (Cloudflare R2) and served
 * statically — they are never executed as server-side code. This validator adds a
 * content-integrity layer on top of that.
 */

// Magic-byte signatures for the media/docs the pipeline legitimately handles.
function detectType(buf) {
  if (!buf || buf.length < 4) return 'unknown';
  const b = buf;
  const hex = (i, arr) => arr.every((v, k) => b[i + k] === v);
  const ascii = (i, s) => b.slice(i, i + s.length).toString('latin1') === s;

  if (hex(0, [0xFF, 0xD8, 0xFF])) return 'image/jpeg';
  if (hex(0, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'image/png';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(0, 'BM')) return 'image/bmp';
  if (ascii(4, 'ftyp')) return 'video/mp4';          // mp4 / mov / m4v (ISO base media)
  if (hex(0, [0x1A, 0x45, 0xDF, 0xA3])) return 'video/webm'; // EBML (webm/mkv)
  if (ascii(0, '%PDF')) return 'application/pdf';
  if (hex(0, [0x50, 0x4B, 0x03, 0x04])) return 'application/zip'; // docx/xlsx/zip/jar
  return 'unknown';
}

// Dangerous binary/script signatures anywhere near the start.
function dangerousSignature(head) {
  const b = head;
  const starts = (arr) => arr.every((v, k) => b[k] === v);
  if (starts([0x4D, 0x5A])) return 'PE/EXE/DLL header (MZ)';
  if (starts([0x7F, 0x45, 0x4C, 0x46])) return 'ELF executable';
  if (starts([0xFE, 0xED, 0xFA, 0xCE]) || starts([0xCE, 0xFA, 0xED, 0xFE]) ||
      starts([0xFE, 0xED, 0xFA, 0xCF]) || starts([0xCF, 0xFA, 0xED, 0xFE])) return 'Mach-O executable';
  if (starts([0x23, 0x21])) return 'Script shebang (#!)';
  if (starts([0xCA, 0xFE, 0xBA, 0xBE])) return 'Java class / Mach-O fat binary';
  const txt = b.toString('latin1').toLowerCase();
  if (txt.includes('<?php') || txt.includes('<?=')) return 'PHP code';
  if (txt.includes('<script')) return 'Embedded <script>';
  if (/^\s*<!doctype html|^\s*<html[\s>]/.test(txt)) return 'HTML document disguised as media';
  return null;
}

const ALLOWED_EXT = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp',            // images
  'mp4', 'mov', 'm4v', 'webm', 'mkv',                    // video
  'pdf', 'doc', 'docx', 'xls', 'xlsx'                    // docs (registration/other)
]);
const DANGEROUS_EXT = new Set([
  'php', 'phtml', 'php3', 'php4', 'php5', 'phar', 'exe', 'dll', 'sh', 'bash',
  'bat', 'cmd', 'com', 'js', 'mjs', 'jsp', 'asp', 'aspx', 'cgi', 'pl', 'py',
  'rb', 'jar', 'htaccess', 'svg', 'html', 'htm', 'xhtml'
]);

function extsOf(name) {
  const parts = String(name || '').toLowerCase().split('.').slice(1);
  return parts; // all extensions (catches double-extension e.g. jpg.php)
}

/**
 * @returns {{ok:boolean, detectedType:string, reasons:string[], severity:string}}
 */
function inspect(buffer, originalName, declaredMime) {
  const reasons = [];
  let severity = 'INFO';
  const bump = (s) => { const order = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']; if (order.indexOf(s) > order.indexOf(severity)) severity = s; };

  try {
    const head = (buffer || Buffer.alloc(0)).slice(0, 4096);
    const detectedType = detectType(buffer);
    const exts = extsOf(originalName);
    const primaryExt = exts[exts.length - 1] || '';
    const mime = String(declaredMime || '').toLowerCase();

    // 1) Hard-dangerous content (executables / scripts hidden in any upload).
    const danger = dangerousSignature(head);
    if (danger) { reasons.push(`Dangerous content: ${danger}`); bump('HIGH'); }

    // 2) SVG with active script (XSS via image).
    const asText = head.toString('latin1').toLowerCase();
    if (asText.includes('<svg') && (asText.includes('<script') || /on\w+\s*=/.test(asText) || asText.includes('javascript:'))) {
      reasons.push('SVG with embedded script/handlers'); bump('HIGH');
    }

    // 3) Dangerous / double extension.
    for (const e of exts) if (DANGEROUS_EXT.has(e)) { reasons.push(`Dangerous extension: .${e}`); bump('HIGH'); }
    if (exts.length > 1 && DANGEROUS_EXT.has(primaryExt)) { reasons.push('Double extension disguise'); bump('HIGH'); }

    // 4) Extension not in the allowlist (only meaningful once we know it's not already flagged).
    if (primaryExt && !ALLOWED_EXT.has(primaryExt) && !DANGEROUS_EXT.has(primaryExt)) {
      reasons.push(`Extension not allowed: .${primaryExt}`); bump('MEDIUM');
    }

    // 5) Declared media type but bytes don't match a known media type (spoofed mime).
    const claimsImage = mime.startsWith('image/');
    const claimsVideo = mime.startsWith('video/');
    if ((claimsImage || claimsVideo) && detectedType === 'unknown') {
      reasons.push(`Declared ${mime} but file signature is not a known ${claimsImage ? 'image' : 'video'}`); bump('MEDIUM');
    }
    // image claimed but detected as video/pdf/zip (or vice-versa) => mismatch
    if (claimsImage && detectedType !== 'unknown' && !detectedType.startsWith('image/')) {
      reasons.push(`Declared image but detected ${detectedType}`); bump('MEDIUM');
    }
    if (claimsVideo && detectedType !== 'unknown' && !detectedType.startsWith('video/')) {
      reasons.push(`Declared video but detected ${detectedType}`); bump('MEDIUM');
    }

    return { ok: reasons.length === 0, detectedType, reasons, severity: reasons.length ? severity : 'INFO' };
  } catch (_) {
    // Fail-open: inspection error must not block/allow decisions incorrectly — treat as clean.
    return { ok: true, detectedType: 'unknown', reasons: [], severity: 'INFO' };
  }
}

module.exports = { inspect, detectType, ALLOWED_EXT, DANGEROUS_EXT };
