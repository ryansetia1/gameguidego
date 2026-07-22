/** @typedef {{ major: boolean }} SpoilerPrefs */

/** @type {SpoilerPrefs} */
export const DEFAULT_SPOILER_PREFS = { major: false };

export const SPOILER_PREFS_KEY = "gg:spoiler-prefs";
export const GLOBAL_SPOILER_MAJOR_KEY = "gg:spoiler-major";
export const SPOILER_TOGGLE_LABEL = "Allow major spoilers";
export const GLOBAL_SPOILER_TOGGLE_LABEL = "Allow spoilers (all games)";
export const GAME_SPOILER_HINT = "Major spoilers for this game only.";

/** @param {string} game */
function normGameKey(game) {
  return game.replace(/\s+/g, " ").trim().toLowerCase();
}

/** @param {unknown} value @returns {SpoilerPrefs} */
export function coerceSpoilerPrefs(value) {
  if (!value || typeof value !== "object") return { ...DEFAULT_SPOILER_PREFS };
  const record = /** @type {Record<string, unknown>} */ (value);
  if (typeof record.major === "boolean") return { major: record.major };
  // ponytail: migrate the old three-toggle shape — any on => major on.
  const legacy =
    record.story === true || record.recruits === true || record.bosses === true;
  return { major: legacy };
}

/** @param {unknown} metadata @returns {boolean | null} */
export function spoilerMajorFromUserMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return null;
  const major = /** @type {Record<string, unknown>} */ (metadata).spoiler_major;
  return typeof major === "boolean" ? major : null;
}

/** @returns {boolean} */
export function loadGlobalSpoilerMajor() {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(GLOBAL_SPOILER_MAJOR_KEY) === "1";
  } catch {
    return false;
  }
}

/** @param {boolean} major */
export function saveGlobalSpoilerMajor(major) {
  if (typeof window === "undefined") return;
  try {
    if (major) window.localStorage.setItem(GLOBAL_SPOILER_MAJOR_KEY, "1");
    else window.localStorage.removeItem(GLOBAL_SPOILER_MAJOR_KEY);
  } catch {
    // private mode
  }
}

/** @returns {SpoilerPrefs} */
export function loadGlobalSpoilerPrefs() {
  return { major: loadGlobalSpoilerMajor() };
}

/** @param {SpoilerPrefs} prefs */
export function saveGlobalSpoilerPrefs(prefs) {
  saveGlobalSpoilerMajor(coerceSpoilerPrefs(prefs).major);
}

/** @param {string} game @returns {SpoilerPrefs} */
export function loadGameSpoilerPrefs(game) {
  if (typeof window === "undefined" || !game.trim()) return { ...DEFAULT_SPOILER_PREFS };
  try {
    const all = JSON.parse(window.localStorage.getItem(SPOILER_PREFS_KEY) || "{}");
    return coerceSpoilerPrefs(all[normGameKey(game)]);
  } catch {
    return { ...DEFAULT_SPOILER_PREFS };
  }
}

/** @param {string} game @param {SpoilerPrefs} prefs */
export function saveGameSpoilerPrefs(game, prefs) {
  if (typeof window === "undefined" || !game.trim()) return;
  try {
    const all = JSON.parse(window.localStorage.getItem(SPOILER_PREFS_KEY) || "{}");
    all[normGameKey(game)] = coerceSpoilerPrefs(prefs);
    window.localStorage.setItem(SPOILER_PREFS_KEY, JSON.stringify(all));
  } catch {
    // private mode
  }
}

/**
 * Global OR per-game — either enables major spoilers for this turn.
 * @param {boolean} globalMajor
 * @param {boolean} gameMajor
 * @returns {SpoilerPrefs}
 */
export function effectiveSpoilerPrefs(globalMajor, gameMajor) {
  return { major: Boolean(globalMajor || gameMajor) };
}

/** @deprecated use loadGlobalSpoilerPrefs */
export function loadSpoilerPrefs() {
  return loadGlobalSpoilerPrefs();
}

/** @deprecated use saveGlobalSpoilerPrefs */
/** @param {SpoilerPrefs} prefs */
export function saveSpoilerPrefs(prefs) {
  saveGlobalSpoilerPrefs(prefs);
}

/** @param {SpoilerPrefs} prefs */
export function hasMajorSpoilersEnabled(prefs) {
  return coerceSpoilerPrefs(prefs).major;
}

/** @param {SpoilerPrefs} prefs */
export function buildSpoilerOutputRules(prefs) {
  const { major } = coerceSpoilerPrefs(prefs);
  if (!major) {
    return (
      'Major spoilers: OFF — use "spoilers":[] and keep "answer" and "highlights" free of major plot twists, deaths, betrayals, identity surprises, endings, and other community-recognized big reveals. ' +
      'Also add a top-level "spoilerRisk": true if your "answer" or "highlights" mention or even brush against any such reveal (directly or indirectly), so it can be double-checked; otherwise "spoilerRisk": false.'
    );
  }
  return (
    'Major spoilers: ON — put ONLY genuinely major, potentially disappointing reveals in the "spoilers" array (collapsed in the app). ' +
    'Routine recruitment, area names, boss tips, and mild story beats belong in "answer" or "highlights", NOT in "spoilers". ' +
    'Each entry: {"detail":"..."} with an optional vague "title" (never the reveal itself). Use "spoilers":[] when nothing qualifies.'
  );
}

/** @param {SpoilerPrefs} prefs */
export function buildSpoilerBlock(prefs) {
  const { major } = coerceSpoilerPrefs(prefs);
  if (!major) {
    return [
      "Major spoiler settings (STRICT — default off):",
      "- BLOCKED: deaths, betrayals, twist endings, hidden antagonists, identity reveals, irreversible story branches, and other reveals players commonly avoid.",
      "- ALLOWED in the main answer: routine party joins, where to go next, shops, items, boss mechanics, and widely-known community facts.",
      "- The web research below WILL contain major spoilers (walkthroughs reveal everything); you must still keep them out of \"answer\" and \"highlights\".",
      "- When withholding a major reveal, still guide what the player can do now without naming the twist. You may note briefly that a major spoiler is hidden.",
    ].join("\n");
  }

  return [
    "Major spoiler settings: ON — the player accepts major reveals in collapsed spoiler sections.",
    "- Put ONLY major, impactful twists in \"spoilers\" — things that would disappoint someone who wanted to discover them organically.",
    "- Do NOT put routine recruitment, mild foreshadowing, or standard walkthrough steps in \"spoilers\".",
    "- Titles must stay vague (e.g. \"Late-game twist\"); the actual reveal goes in \"detail\" only.",
  ].join("\n");
}

// Second-pass safety net: only invoked when spoilers are OFF and the model
// self-flagged spoilerRisk, so most turns never pay for it.
export const SPOILER_CENSOR_INSTRUCTION = `You are a spoiler censor for a video-game guide. The player has spoilers turned OFF and must NOT see major reveals.
Rewrite the given guide so it removes or obscures every MAJOR spoiler — character deaths, betrayals, twist endings, hidden or true antagonists, identity reveals, and irreversible story branches — while preserving ALL actionable guidance (where to go, what to do, item and shop names, boss tactics, routine recruits, puzzle solutions).
Only strip genuinely major, discovery-ruining reveals; keep routine walkthrough steps and mild story context. Where a step depended on naming a twist, keep the step but describe it without the reveal (e.g. "a later story event" instead of naming it). Do not add new facts.
If removing the spoilers would leave nothing useful (the question was itself asking for a reveal), do NOT return an empty answer, and do NOT say you are hiding something, that it is a spoiler, or that you cannot answer — that itself hints at the reveal and invites the player to speculate. Instead, naturally steer the player toward what they can do right now (keep playing a specific area, prep for the next fight, explore) so the moment stays a surprise, without naming or confirming the reveal.
Always write a non-empty "answer" in the same language as the guide. Respond with ONLY a JSON object shaped exactly like {"answer":"...","highlights":[...]}, reusing the same highlight shape as the input. No commentary before or after.`;

/**
 * @param {{ answer: string, highlights?: import("./highlights.js").Highlight[] }} input
 */
export function buildSpoilerCensorPrompt({ answer, highlights = [] }) {
  return `Guide to sanitise (JSON):\n${JSON.stringify({ answer, highlights })}`;
}
