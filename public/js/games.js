// Short game name mappings for compact views (account cards, game chips).
// Full game names (GAME_NAMES, getGameName) are defined in app.js.
// Load this file before app.js on pages that need short name lookups.

const SHORT_GAME_NAMES = {
  730: 'CS2',
  570: 'Dota 2',
  440: 'TF2',
  252490: 'Rust',
  578080: 'PUBG',
  271590: 'GTA V',
  359550: 'R6 Siege',
  1172470: 'Apex',
  1623730: 'Palworld',
  892970: 'Valheim',
  105600: 'Terraria',
  230410: 'Warframe',
  252950: 'Rocket League',
  1085660: 'Destiny 2',
  1091500: 'Cyberpunk 2077',
  493340: 'Planet Coaster',
  346110: 'ARK',
  3164500: 'Dark and Darker',
  428690: 'Fortnite',
  813780: 'AoE II'
};

function getShortGameName(appId) {
  // SHORT_GAME_NAMES first, then fall back to full GAME_NAMES (from app.js), then raw ID
  if (SHORT_GAME_NAMES[appId]) return SHORT_GAME_NAMES[appId];
  if (typeof GAME_NAMES !== 'undefined' && GAME_NAMES[appId]) return GAME_NAMES[appId];
  return `ID: ${appId}`;
}
