/** @typedef {'collecting' | 'draft' | 'full'} PlayerMemoryTier */
/** @typedef {{ answerLength?: string, tone?: string, language?: string, detailLevel?: string, notes?: string[] }} PlayerStyleShape */
/** @typedef {{ tier: PlayerMemoryTier, style: PlayerStyleShape, gameMemory?: { progress?: string, notes?: string[] } | null }} PlayerMemoryPromptInput */

export const MEMORY_DRAFT_THRESHOLD = 5;
export const MEMORY_FULL_THRESHOLD = 10;
export const MEMORY_STYLE_NOTE_CAP = 5;
export const MEMORY_GAME_NOTE_CAP = 5;
export const MEMORY_REFRESH_COOLDOWN_MS = 60 * 60 * 1000;
export const MEMORY_DELTA_MESSAGE_CAP = 50;

export const MEMORY_TOGGLE_LABEL = "Learn my style";
export const MEMORY_TOGGLE_HINT =
  "Tailor answer length and tone to how you ask questions. Off by default.";

const STYLE_LENGTH = new Set(["short", "medium", "detailed"]);
const STYLE_TONE = new Set(["casual", "direct"]);
const STYLE_LANG = new Set(["id", "en", "mixed"]);
const STYLE_DETAIL = new Set(["steps", "context", "minimal"]);
const TIERS = new Set(["collecting", "draft", "full"]);

/** @param {string} game */
export function normGameKey(game) {
  return game.replace(/\s+/g, " ").trim().toLowerCase();
}

/** @param {number} count @returns {PlayerMemoryTier} */
export function tierFromMessageCount(count) {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (n < MEMORY_DRAFT_THRESHOLD) return "collecting";
  if (n < MEMORY_FULL_THRESHOLD) return "draft";
  return "full";
}

/** @param {unknown} metadata @returns {boolean} */
export function playerMemoryEnabledFromMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return false;
  return /** @type {Record<string, unknown>} */ (metadata).player_memory_enabled === true;
}

/** @param {unknown} value @returns {PlayerStyleShape} */
export function coercePlayerStyle(value) {
  if (!value || typeof value !== "object") return { notes: [] };
  const record = /** @type {Record<string, unknown>} */ (value);
  /** @type {PlayerStyleShape} */
  const style = { notes: [] };
  if (typeof record.answerLength === "string" && STYLE_LENGTH.has(record.answerLength)) {
    style.answerLength = record.answerLength;
  }
  if (typeof record.tone === "string" && STYLE_TONE.has(record.tone)) {
    style.tone = record.tone;
  }
  if (typeof record.language === "string" && STYLE_LANG.has(record.language)) {
    style.language = record.language;
  }
  if (typeof record.detailLevel === "string" && STYLE_DETAIL.has(record.detailLevel)) {
    style.detailLevel = record.detailLevel;
  }
  if (Array.isArray(record.notes)) {
    style.notes = record.notes
      .flatMap((item) => (typeof item === "string" ? [item.replace(/\s+/g, " ").trim()] : []))
      .filter(Boolean)
      .slice(0, MEMORY_STYLE_NOTE_CAP);
  }
  return style;
}

/** @param {unknown} tier @param {number} messageCount @returns {PlayerMemoryTier} */
export function coercePlayerMemoryTier(tier, messageCount) {
  if (typeof tier === "string" && TIERS.has(tier)) {
    return /** @type {PlayerMemoryTier} */ (tier);
  }
  return tierFromMessageCount(messageCount);
}

/** @param {PlayerStyleShape} style @returns {string[]} */
export function styleBulletsForPrompt(style) {
  const bullets = [];
  if (style.answerLength === "short") bullets.push("Prefers short answers");
  else if (style.answerLength === "detailed") bullets.push("Prefers detailed answers");
  else if (style.answerLength === "medium") bullets.push("Prefers medium-length answers");

  if (style.tone === "casual") bullets.push("Likes a casual, friendly tone");
  else if (style.tone === "direct") bullets.push("Likes direct, to-the-point replies");

  if (style.language === "id") bullets.push("Usually writes in Indonesian");
  else if (style.language === "en") bullets.push("Usually writes in English");
  else if (style.language === "mixed") bullets.push("Switches between Indonesian and English");

  if (style.detailLevel === "steps") bullets.push("Focuses on step-by-step walkthroughs");
  else if (style.detailLevel === "context") bullets.push("Appreciates story or context when relevant");
  else if (style.detailLevel === "minimal") bullets.push("Wants only the essentials");

  for (const note of style.notes ?? []) {
    if (note && bullets.length < MEMORY_STYLE_NOTE_CAP) bullets.push(note);
  }
  return bullets.slice(0, MEMORY_STYLE_NOTE_CAP);
}

/**
 * @param {PlayerMemoryPromptInput | null | undefined} memory
 * @returns {string}
 */
export function buildPlayerMemoryPromptBlock(memory) {
  if (!memory || memory.tier === "collecting") return "";

  const bullets = styleBulletsForPrompt(memory.style);
  const gameLines = [];
  const progress = memory.gameMemory?.progress?.trim();
  if (progress) gameLines.push(`Progress: ${progress}`);
  for (const note of memory.gameMemory?.notes ?? []) {
    if (note?.trim()) gameLines.push(note.trim());
  }

  let block = "";
  if (bullets.length) {
    const header =
      memory.tier === "draft"
        ? "Player style (early draft, use as a soft hint only):"
        : "Player style (learned from past chats):";
    const footer =
      memory.tier === "draft"
        ? "Do not change factual game guidance to match these hints."
        : "Adapt answer length and tone accordingly. Do not invent facts about the player.";
    block = `${header}\n${bullets.map((line) => `- ${line}`).join("\n")}\n${footer}\n\n`;
  }

  if (gameLines.length) {
    block +=
      `What we know about this player in this game:\n${gameLines.map((line) => `- ${line}`).join("\n")}\n\n`;
  }

  return block;
}

/**
 * Extract user messages from saved chat rows for summarize delta input.
 * @param {Array<{ game?: string, platform?: string, messages?: unknown, updated_at?: string }>} chats
 * @param {string | null | undefined} sinceIso
 * @returns {{ game: string, platform: string, content: string, at: string }[]}
 */
export function extractUserMessagesFromChats(chats, sinceIso) {
  const since = sinceIso ? Date.parse(sinceIso) : 0;
  /** @type {{ game: string, platform: string, content: string, at: string }[]} */
  const out = [];
  for (const chat of chats ?? []) {
    if (!Array.isArray(chat.messages)) continue;
    const game = typeof chat.game === "string" ? chat.game : "";
    const platform = typeof chat.platform === "string" ? chat.platform : "";
    const updatedAt = typeof chat.updated_at === "string" ? chat.updated_at : "";
    for (const item of chat.messages) {
      if (!item || typeof item !== "object") continue;
      const role = "role" in item ? item.role : undefined;
      const content = "content" in item && typeof item.content === "string" ? item.content.trim() : "";
      if (role !== "user" || !content) continue;
      const at =
        "created_at" in item && typeof item.created_at === "string"
          ? item.created_at
          : updatedAt;
      if (since && Number.isFinite(since) && at && Date.parse(at) <= since) continue;
      out.push({ game, platform, content: content.slice(0, 800), at: at || updatedAt });
    }
  }
  return out
    .sort((a, b) => Date.parse(a.at || "") - Date.parse(b.at || ""))
    .slice(-MEMORY_DELTA_MESSAGE_CAP);
}

/** @param {string | null | undefined} lastManual @param {number} [now] */
export function memoryRefreshCooldownRemainingMs(lastManual, now = Date.now()) {
  if (!lastManual) return 0;
  const last = Date.parse(lastManual);
  if (!Number.isFinite(last)) return 0;
  return Math.max(0, MEMORY_REFRESH_COOLDOWN_MS - (now - last));
}
