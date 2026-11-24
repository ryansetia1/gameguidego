/**
 * @typedef {{ group: string, items: string[] }} PlatformGroup
 */

/** @type {PlatformGroup[]} */
export const PLATFORMS = [
  {
    group: "Nintendo",
    items: [
      "NES",
      "SNES",
      "Nintendo 64",
      "GameCube",
      "Wii",
      "Wii U",
      "Nintendo Switch",
      "Nintendo Switch 2",
      "Game Boy",
      "Game Boy Color",
      "Game Boy Advance",
      "Nintendo DS",
      "Nintendo 3DS",
    ],
  },
  {
    group: "PlayStation",
    items: [
      "PlayStation (PS1)",
      "PlayStation 2",
      "PlayStation 3",
      "PlayStation 4",
      "PlayStation 5",
      "PSP",
      "PS Vita",
    ],
  },
  {
    group: "Xbox",
    items: ["Xbox", "Xbox 360", "Xbox One", "Xbox Series X|S"],
  },
  {
    group: "Sega",
    items: ["Sega Genesis / Mega Drive", "Sega Saturn", "Dreamcast"],
  },
  {
    group: "Other",
    items: ["PC", "Mobile (iOS/Android)", "Arcade"],
  },
];

// Acronyms and common shorthands players actually type. Keys are exact platform
// names; matching is done against these plus the name itself.
/** @type {Record<string, string[]>} */
const ALIASES = {
  NES: ["famicom"],
  SNES: ["super nintendo", "super famicom", "sfc"],
  "Nintendo 64": ["n64"],
  GameCube: ["gcn", "ngc", "gc"],
  "Wii U": ["wiiu"],
  "Nintendo Switch": ["switch", "nsw"],
  "Nintendo Switch 2": ["switch 2", "switch2"],
  "Game Boy": ["gb", "gameboy"],
  "Game Boy Color": ["gbc"],
  "Game Boy Advance": ["gba"],
  "Nintendo DS": ["nds", "ds"],
  "Nintendo 3DS": ["3ds", "n3ds"],
  "PlayStation (PS1)": ["ps1", "psx", "psone", "playstation 1"],
  "PlayStation 2": ["ps2"],
  "PlayStation 3": ["ps3"],
  "PlayStation 4": ["ps4"],
  "PlayStation 5": ["ps5"],
  PSP: ["playstation portable"],
  "PS Vita": ["vita", "psvita"],
  Xbox: ["original xbox", "og xbox"],
  "Xbox 360": ["x360", "360"],
  "Xbox One": ["xone", "xb1", "xbox1"],
  "Xbox Series X|S": ["xsx", "xss", "series x", "series s", "xbox series"],
  "Sega Genesis / Mega Drive": ["genesis", "mega drive", "megadrive", "md", "smd"],
  "Sega Saturn": ["saturn"],
  Dreamcast: ["dc"],
  PC: ["windows", "steam"],
  "Mobile (iOS/Android)": ["mobile", "ios", "android", "iphone", "ipad"],
  Arcade: ["mame"],
};

/** @param {string} value */
function normalize(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Precompute normalized haystacks (name + aliases) per platform once.
/** @type {Map<string, string[]>} */
const HAYSTACKS = new Map();
for (const section of PLATFORMS) {
  for (const item of section.items) {
    HAYSTACKS.set(item, [item, ...(ALIASES[item] || [])].map(normalize));
  }
}

// IGDB (and legacy TheGamesDB) platform names -> our labels, most specific first (numbered consoles
// before the bare family name, so "Sony Playstation 2" isn't caught by "PS1").
// ponytail: keyword rules over an exact id table (TGDB ids are unverified here);
// returns "" when unsure so we never auto-fill the wrong platform.
/** @type {[RegExp, string][]} */
const TGDB_RULES = [
  // Headsets are not the console ("PlayStation VR" must not fall into PS1).
  [/\bvr\d*\b|oculus|quest|vive|mixed reality/i, ""],
  [/super\s*(nintendo|famicom)|\bsnes\b/i, "SNES"],
  [/nintendo\s*64|\bn64\b/i, "Nintendo 64"],
  [/game\s*cube|gamecube/i, "GameCube"],
  [/wii\s*u/i, "Wii U"],
  [/switch\s*2/i, "Nintendo Switch 2"],
  [/switch/i, "Nintendo Switch"],
  [/game\s*boy\s*advance|\bgba\b/i, "Game Boy Advance"],
  [/game\s*boy\s*color|\bgbc\b/i, "Game Boy Color"],
  [/game\s*boy/i, "Game Boy"],
  [/nintendo\s*3ds|\b3ds\b/i, "Nintendo 3DS"],
  [/nintendo\s*ds|\bnds\b/i, "Nintendo DS"],
  [/\bwii\b/i, "Wii"],
  [/nintendo entertainment|famicom|\bnes\b/i, "NES"],
  [/playstation\s*5|\bps5\b/i, "PlayStation 5"],
  [/playstation\s*4|\bps4\b/i, "PlayStation 4"],
  [/playstation\s*3|\bps3\b/i, "PlayStation 3"],
  [/playstation\s*2|\bps2\b/i, "PlayStation 2"],
  [/playstation\s*vita|ps\s*vita|\bvita\b/i, "PS Vita"],
  [/playstation\s*portable|\bpsp\b/i, "PSP"],
  [/playstation/i, "PlayStation (PS1)"],
  [/xbox\s*series/i, "Xbox Series X|S"],
  [/xbox\s*one/i, "Xbox One"],
  [/xbox\s*360/i, "Xbox 360"],
  [/xbox/i, "Xbox"],
  [/mega\s*drive|genesis/i, "Sega Genesis / Mega Drive"],
  [/saturn/i, "Sega Saturn"],
  [/dreamcast/i, "Dreamcast"],
  [/\bpc\b|windows|\bmac\b|linux/i, "PC"],
  [/android|\bios\b|iphone|ipad|mobile/i, "Mobile (iOS/Android)"],
  [/arcade|\bmame\b/i, "Arcade"],
];

/**
 * Map an IGDB/TheGamesDB platform name to one of our platform labels, or "" if none
 * confidently matches (so the caller leaves the field for manual selection).
 *
 * @param {string} name
 * @returns {string}
 */
export function tgdbPlatformToLabel(name) {
  const value = String(name || "");
  for (const [pattern, label] of TGDB_RULES) {
    if (pattern.test(value)) return label;
  }
  return "";
}

/**
 * Filter the grouped platform list by a fuzzy, acronym-aware query. An empty
 * query returns every group. Matching is normalized-substring (case- and
 * punctuation-insensitive) against each platform's name and its aliases, so
 * "n64", "nds", "psx", "ps1", "ps2" all resolve to the right console.
 *
 * @param {string} query
 * @returns {PlatformGroup[]}
 */
export function matchPlatforms(query) {
  const needle = normalize(query || "");
  if (!needle) return PLATFORMS;
  return PLATFORMS.map((section) => ({
    group: section.group,
    items: section.items.filter((item) =>
      (HAYSTACKS.get(item) || []).some((part) => part.includes(needle)),
    ),
  })).filter((section) => section.items.length > 0);
}

/**
 * Resolve any platform spelling (our label, an alias like "gba", or a longer name such as
 * "Super Nintendo (SNES)") to one of our labels, or "" when unsure.
 *
 * @param {string} name
 * @returns {string}
 */
export function platformLabelFor(name) {
  const needle = normalize(String(name || ""));
  if (!needle) return "";
  for (const [label, keys] of HAYSTACKS) {
    if (keys.includes(needle)) return label;
  }
  return tgdbPlatformToLabel(name);
}
