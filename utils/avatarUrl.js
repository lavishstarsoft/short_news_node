'use strict';

/**
 * Deterministic, colourful letter-avatar URL for a name. Used for quiz winners who
 * have no real profile photo (hand-typed / manual winners) so the app shows a vibrant
 * coloured circle instead of its plain pale fallback. Same name → same colour.
 */
const AVATAR_COLORS = ['7E57C2', '5E35B1', '2E7D32', '00897B', '1E88E5', 'C2185B', 'F4511E', '6D4C41', '512DA8', 'AD1457', '00838F', '283593'];

function avatarUrlFor(name) {
  const n = String(name || 'W').trim() || 'W';
  let h = 0; for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
  const bg = AVATAR_COLORS[h % AVATAR_COLORS.length];
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(n)}&length=1&background=${bg}&color=ffffff&bold=true&size=128&format=png`;
}

module.exports = { avatarUrlFor, AVATAR_COLORS };
