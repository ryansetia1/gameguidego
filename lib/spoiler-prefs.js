/** @typedef {{ major: boolean }} SpoilerPrefs */

/** @type {SpoilerPrefs} */
export const DEFAULT_SPOILER_PREFS = { major: false };

export const SPOILER_PREFS_KEY = "gg:spoiler-prefs";
export const GLOBAL_SPOILER_MAJOR_KEY = "gg:spoiler-major";
export const TOPIC_SPOILER_BY_ID_KEY = "gg:topic-spoiler";
export const SPOILER_TOGGLE_LABEL = "Allow major spoilers";
export const GLOBAL_SPOILER_TOGGLE_LABEL = "Allow spoilers (all games)";
export const GAME_SPOILER_HINT = "Major spoilers for this game only.";
export const SPOILER_MODE_ON_LABEL = "Spoilers on";
export const TOPIC_SPOILER_CHIP_LABEL = "Spoilers";
export const SPOILER_MODE_OFF_TITLE = "Turn off major spoilers";

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
 * Per-topic spoiler prefs. Topic row wins; per-chat localStorage, then legacy per-game.
 * @param {{ id?: string; spoiler_major?: boolean } | null | undefined} chat
 * @param {string} [game]
 * @returns {SpoilerPrefs}
 */
export function loadTopicSpoilerPrefs(chat, game = "") {
  if (chat && typeof chat.spoiler_major === "boolean") {
    return { major: chat.spoiler_major };
  }
  if (chat?.id) {
    const stored = loadTopicSpoilerMajorById(chat.id);
    if (stored !== null) return { major: stored };
  }
  if (game.trim()) return loadGameSpoilerPrefs(game);
  return { ...DEFAULT_SPOILER_PREFS };
}

/** @param {string} chatId @returns {boolean | null} */
export function loadTopicSpoilerMajorById(chatId) {
  if (!chatId || typeof window === "undefined") return null;
  try {
    const all = JSON.parse(window.localStorage.getItem(TOPIC_SPOILER_BY_ID_KEY) || "{}");
    const value = all[chatId];
    return typeof value === "boolean" ? value : null;
  } catch {
    return null;
  }
}

/** @param {string} chatId @param {boolean} major */
export function saveTopicSpoilerMajorById(chatId, major) {
  if (!chatId || typeof window === "undefined") return;
  try {
    const all = JSON.parse(window.localStorage.getItem(TOPIC_SPOILER_BY_ID_KEY) || "{}");
    if (major) all[chatId] = true;
    else delete all[chatId];
    window.localStorage.setItem(TOPIC_SPOILER_BY_ID_KEY, JSON.stringify(all));
  } catch {
    // private mode
  }
}

/** @param {boolean} major */
export function topicSpoilerPayload(major) {
  return { spoiler_major: Boolean(major) };
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

// How to withhold a reveal WITHOUT leaking meta-info. Announcing a spoiler
// policy, saying you can't answer, or naming what's withheld (even its category,
// "a death") all CONFIRM the reveal and invite speculation — the opposite of
// protecting the player. Shared by the OFF summarize block and the censor pass
// so the two never drift (they did: censor got fixed while this block still said
// "you may note a spoiler is hidden", and the model dutifully announced it).
const GRACEFUL_WITHHOLD =
  'If the honest answer would itself be a major reveal, do NOT announce a spoiler policy, say you cannot answer, apologise for withholding, or name what is being withheld (not even its category such as "a death" or "a betrayal"). Naming or hinting at it confirms the reveal and invites the player to speculate. Instead, act like a friend who knows the story but keeps it a surprise: naturally steer the player toward what they can do right now (keep playing a specific area, prep for the next fight, explore).';

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
    'Major spoilers: ON. If the question directly asks for a reveal, put the actual answer in "answer" (they opted in); use your own knowledge when the research is silent. ' +
    'Reserve the "spoilers" array (collapsed in the app) for ADDITIONAL major reveals the player did not ask about. ' +
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
      "- " + GRACEFUL_WITHHOLD,
    ].join("\n");
  }

  return [
    "Major spoiler settings: ON — the player accepts major reveals.",
    "- If the player's question itself asks for a major reveal (e.g. \"does X die?\", \"who is the traitor?\", \"how does it end?\"), answer it directly and fully in \"answer\"; they explicitly asked for it. Answer from your own game knowledge when the research does not cover it, instead of staying vague.",
    "- Reserve \"spoilers\" for ADDITIONAL major twists the player did NOT ask about (things they'd want to discover organically), so they stay collapsed.",
    "- Do NOT put routine recruitment, mild foreshadowing, or standard walkthrough steps in \"spoilers\".",
    "- Titles must stay vague (e.g. \"Late-game twist\"); the actual reveal goes in \"detail\" only.",
  ].join("\n");
}

// Second-pass safety net: only invoked when spoilers are OFF and the model
// self-flagged spoilerRisk, so most turns never pay for it.
export const SPOILER_CENSOR_INSTRUCTION = `You are a spoiler censor for a video-game guide. The player has spoilers turned OFF and must NOT see major reveals.
Rewrite the given guide so it removes or obscures every MAJOR spoiler — character deaths, betrayals, twist endings, hidden or true antagonists, identity reveals, and irreversible story branches — while preserving ALL actionable guidance (where to go, what to do, item and shop names, boss tactics, routine recruits, puzzle solutions).
Only strip genuinely major, discovery-ruining reveals; keep routine walkthrough steps and mild story context. Where a step depended on naming a twist, keep the step but describe it without the reveal (e.g. "a later story event" instead of naming it). Do not add new facts.
If removing the spoilers would leave nothing useful (the question was itself asking for a reveal), do NOT return an empty answer. ${GRACEFUL_WITHHOLD}
Always write a non-empty "answer" in the same language as the guide. Respond with ONLY a JSON object shaped exactly like {"answer":"...","highlights":[...]}, reusing the same highlight shape as the input. No commentary before or after.`;

/**
 * @param {{ answer: string, highlights?: import("./highlights.js").Highlight[] }} input
 */
export function buildSpoilerCensorPrompt({ answer, highlights = [] }) {
  return `Guide to sanitise (JSON):\n${JSON.stringify({ answer, highlights })}`;
}
