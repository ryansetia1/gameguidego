/**
 * Group chats rows into game+platform "rooms". Each row is one topic; cover and
 * guides are shared across topics in the same room (synced on write).
 */

/** @param {string} game */
export function normGameKey(game) {
  return game.replace(/\s+/g, " ").trim().toLowerCase();
}

/** @param {string} game @param {string} [platform] */
export function gameRoomKey(game, platform = "") {
  return `${normGameKey(game)}|${platform.replace(/\s+/g, " ").trim().toLowerCase()}`;
}

/**
 * @param {import("./supabase").Chat} chat
 * @returns {{ cover_url: string; release_year: string; preferred_guide_url: string; preferred_guide_urls?: string[] }}
 */
export function sharedMetaFromChat(chat) {
  return {
    cover_url: chat.cover_url ?? "",
    release_year: chat.release_year ?? "",
    preferred_guide_url: chat.preferred_guide_url ?? "",
    preferred_guide_urls: chat.preferred_guide_urls,
  };
}

/** Fields propagated to every topic in a room — never touches updated_at on siblings. */
export const SHARED_GAME_META_KEYS = [
  "cover_url",
  "release_year",
  "preferred_guide_url",
  "preferred_guide_urls",
];

/**
 * @typedef {{ key: string; game: string; platform: string; cover_url: string; release_year: string; preferred_guide_url: string; preferred_guide_urls?: string[]; updated_at: string; topics: import("./supabase").Chat[]; representative: import("./supabase").Chat }} GameRoom
 */

/**
 * @param {import("./supabase").Chat[]} chats
 * @returns {GameRoom[]}
 */
export function groupChatsByRoom(chats) {
  /** @type {Map<string, GameRoom>} */
  const map = new Map();
  for (const chat of chats) {
    const key = gameRoomKey(chat.game, chat.platform);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        key,
        game: chat.game,
        platform: chat.platform,
        cover_url: chat.cover_url ?? "",
        release_year: chat.release_year ?? "",
        preferred_guide_url: chat.preferred_guide_url ?? "",
        preferred_guide_urls: chat.preferred_guide_urls,
        updated_at: chat.updated_at,
        topics: [chat],
        representative: chat,
      });
      continue;
    }
    existing.topics.push(chat);
    if (topicActivityMs(chat) > topicActivityMs({ updated_at: existing.updated_at })) {
      existing.updated_at = chat.updated_at;
      existing.representative = chat;
      const shared = sharedMetaFromChat(chat);
      existing.cover_url = shared.cover_url;
      existing.release_year = shared.release_year;
      existing.preferred_guide_url = shared.preferred_guide_url;
      existing.preferred_guide_urls = shared.preferred_guide_urls;
    }
  }
  return [...map.values()]
    .map((room) => ({
      ...room,
      topics: [...room.topics].sort(compareTopicActivity),
    }))
    .sort((a, b) =>
      compareTopicActivity({ updated_at: a.updated_at }, { updated_at: b.updated_at }),
    );
}

/**
 * @param {{ updated_at?: string | null }} chat
 * @returns {number}
 */
export function topicActivityMs(chat) {
  const ms = Date.parse(String(chat.updated_at || ""));
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Newest interaction first.
 * @param {{ updated_at?: string | null }} a
 * @param {{ updated_at?: string | null }} b
 */
export function compareTopicActivity(a, b) {
  return topicActivityMs(b) - topicActivityMs(a);
}

/**
 * @param {import("./supabase").Chat[]} chats
 * @param {import("./supabase").Chat} entry
 * @returns {import("./supabase").Chat[]}
 */
export function upsertChatInList(chats, entry) {
  const rest = chats.filter((row) => row.id !== entry.id);
  return [...rest, entry].sort(compareTopicActivity);
}

/** Local-only rows younger than this are kept when the server list lags on insert. */
export const LOCAL_CHAT_GRACE_MS = 120_000;

/**
 * Keep optimistic/local rows when the server list lags (e.g. new topic just saved).
 * Local-only rows older than LOCAL_CHAT_GRACE_MS are dropped so deletes are not undone.
 * @param {import("./supabase").Chat[]} local
 * @param {import("./supabase").Chat[]} remote
 * @returns {import("./supabase").Chat[]}
 */
export function mergeChatsFromServer(local, remote) {
  const now = Date.now();
  /** @type {Map<string, import("./supabase").Chat>} */
  const map = new Map();
  for (const row of remote) map.set(row.id, row);
  for (const row of local) {
    const existing = map.get(row.id);
    if (!existing) {
      if (now - topicActivityMs(row) <= LOCAL_CHAT_GRACE_MS) {
        map.set(row.id, row);
      }
      continue;
    }
    const newer = topicActivityMs(row) >= topicActivityMs(existing) ? row : existing;
    const older = newer === row ? existing : row;
    map.set(row.id, { ...older, ...newer });
  }
  return [...map.values()].sort(compareTopicActivity);
}

/**
 * @param {import("./supabase").Chat[]} chats
 * @param {string} game
 * @param {string} platform
 * @returns {import("./supabase").Chat[]}
 */
export function topicsForRoom(chats, game, platform) {
  const key = gameRoomKey(game, platform);
  return chats
    .filter((row) => gameRoomKey(row.game, row.platform) === key)
    .sort(compareTopicActivity);
}

/**
 * @param {import("./supabase").Chat[]} games
 * @param {string} game
 * @param {string} platform
 * @param {Record<string, unknown>} meta
 * @returns {import("./supabase").Chat[]}
 */
export function syncSharedMetaToLocalGames(games, game, platform, meta) {
  const key = gameRoomKey(game, platform);
  return games.map((row) =>
    gameRoomKey(row.game, row.platform) === key ? { ...row, ...meta } : row,
  );
}

/** True when Supabase rejects chat-topics migration columns. @param {unknown} error */
export function isTopicColumnDbError(error) {
  const msg =
    error && typeof error === "object" && "message" in error
      ? String(/** @type {{ message?: unknown }} */ (error).message ?? "")
      : "";
  return (
    /column .*(title|spoiler_major|visual_search).* does not exist/i.test(msg) ||
    /Could not find the '(title|spoiler_major|visual_search)' column/i.test(msg)
  );
}

/**
 * Propagate shared room metadata to every topic row (signed-in).
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} userId
 * @param {string} game
 * @param {string} platform
 * @param {Record<string, unknown>} meta
 */
export async function syncRoomSharedMeta(supabase, userId, game, platform, meta) {
  const { error } = await supabase
    .from("chats")
    .update(meta)
    .eq("user_id", userId)
    .eq("game", game)
    .eq("platform", platform);
  if (error) throw error;
}

/** Strip topic-only columns for legacy `chats` rows (pre chat-topics.sql). @param {Record<string, unknown>} payload */
export function chatPayloadWithoutTopicColumns(payload) {
  const { title, spoiler_major, visual_search, ...rest } = payload;
  return rest;
}