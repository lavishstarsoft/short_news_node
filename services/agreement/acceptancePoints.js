'use strict';

/**
 * acceptancePoints.js — DETERMINISTIC parser + canonicalization for point-by-point
 * T&C acceptance. This is the SINGLE source of truth used by:
 *   - Admin create/publish validation (agreementTermsController)
 *   - Server-side acceptance validation (agreementController.accept)
 *   - Admin "detected points" + live preview endpoint
 *
 * Marker syntax (line-based, case-insensitive):
 *   [[ACCEPT]] I have read, understood and agree to this point.      → required
 *   [[ACCEPT:optional]] Optional analytics note.                      → optional
 *
 * The full legal text is NEVER modified — markers stay in the body; only their
 * position is used to render checkboxes and derive metadata.
 *
 * Keys are ORDER-BASED and STABLE for a given body: accept_001, accept_002, …
 * The same body always yields the same keys/labels/required flags.
 */

// A line that IS a well-formed marker.
const MARKER_RE = /^[ \t]*\[\[ACCEPT(:optional)?\]\][ \t]*(.*?)[ \t]*$/i;
// A line that LOOKS like an acceptance marker attempt (to catch malformed ones).
const MARKER_HINT_RE = /\[\[\s*ACCEPT/i;

function keyForOrder(order) {
  return 'accept_' + String(order).padStart(3, '0');
}

/**
 * Parse a T&C body into structured acceptance points + validation errors.
 * @param {string} body
 * @returns {{ points: Array<{key,label,required,order,anchor}>, errors: string[], markerLines: number[] }}
 */
function parse(body) {
  const text = String(body == null ? '' : body);
  const lines = text.split('\n');
  const points = [];
  const errors = [];
  const markerLines = [];
  let order = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = MARKER_RE.exec(line);
    if (m) {
      const label = (m[2] || '').trim();
      if (!label) {
        errors.push(`Line ${i + 1}: acceptance marker has no label text.`);
        continue; // do not create a keyless/labelless point
      }
      order += 1;
      points.push({
        key: keyForOrder(order),
        label,
        required: !m[1], // ":optional" present → optional
        order,
        anchor: i // 0-based source line index (for stable inline placement)
      });
      markerLines.push(i);
    } else if (MARKER_HINT_RE.test(line)) {
      // Looks like a marker attempt but does not match the strict syntax → fail loudly.
      errors.push(`Line ${i + 1}: malformed acceptance marker. Use exactly "[[ACCEPT]] label" or "[[ACCEPT:optional]] label".`);
    }
  }

  // Duplicate label detection (keys are always unique by order; labels are flagged, not fatal-keyed).
  const seen = new Map();
  for (const p of points) {
    const norm = p.label.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(norm)) errors.push(`Duplicate acceptance label at ${p.key} (same text as ${seen.get(norm)}). Use distinct labels.`);
    else seen.set(norm, p.key);
  }

  return { points, errors, markerLines };
}

/** Required-point keys (sorted) for a given points array. */
function requiredKeys(points) {
  return (points || []).filter(p => p.required).map(p => p.key).sort();
}

/**
 * Canonical, deterministic string binding the required set and the accepted set to
 * a T&C version + hash. Fed into AgreementAcceptance.computeHash for NEW point-aware
 * records only. Never hash raw client JSON — this canonicalizes first.
 */
function canonicalForHash({ tncVersion, tncHash, required, accepted }) {
  const req = [...new Set((required || []).map(String))].sort();
  const acc = [...new Set((accepted || []).map(String))].sort();
  return `v=${tncVersion || ''}|h=${tncHash || ''}|req=${req.join(',')}|acc=${acc.join(',')}`;
}

module.exports = { parse, requiredKeys, canonicalForHash, keyForOrder, MARKER_RE };
