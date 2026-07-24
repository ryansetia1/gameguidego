/**
 * Anonymous "recent games" persistence in localStorage. Signed-in users store
 * their games in Supabase `public.chats`; signed-out users have no server row,
 * so we keep a small local list here so the quick-access carousel, sidebar, and
 * library light up for them too. Entries are `Chat`-shaped (minus `user_id`) so
 * the existing UI (`openChat`, sidebar rows, library grid) works unchanged.
 *
 * Anon has no Storage (cover upload / image attach are signed-in only), so these
 * rows are plain text + metadata; `cover_url` is only ever a hotlinked CDN URL
 * or "". ponytail: cap the list and drop the oldest — a browser quota guard, not
 * a real DB; upgrade path is IndexedDB if threads ever grow large.
 */

export const LOCAL_GAMES_KEY = "gg:local-games";
const MAX_GAMES = 20;

/** @returns {import("./supabase").Chat[]} newest-first list, or [] on any error */
export function loadLocalGames() {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_GAMES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((row) => row && typeof row === "object" && typeof row.id === "string")
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  } catch {
    return [];
  }
}

/** @param {import("./supabase").Chat[]} games */
function save(games) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCAL_GAMES_KEY, JSON.stringify(games.slice(0, MAX_GAMES)));
  } catch {
    // quota / private mode — best-effort, the feature just won't persist.
  }
}

/** @param {import("./supabase").Chat[]} games @returns {import("./supabase").Chat[]} */
export function setLocalGames(games) {
  const next = [...games].sort((a, b) =>
    String(b.updated_at).localeCompare(String(a.updated_at)),
  );
  save(next);
  return next.slice(0, MAX_GAMES);
}

/**
 * Insert or update a game by id and return the full newest-first list.
 * @param {import("./supabase").Chat} entry
 * @returns {import("./supabase").Chat[]}
 */
export function upsertLocalGame(entry) {
  const rest = loadLocalGames().filter((row) => row.id !== entry.id);
  const next = [entry, ...rest].sort((a, b) =>
    String(b.updated_at).localeCompare(String(a.updated_at)),
  );
  save(next);
  return next.slice(0, MAX_GAMES);
}

/**
 * Remove a game by id and return the remaining newest-first list.
 * @param {string} id
 * @returns {import("./supabase").Chat[]}
 */
export function removeLocalGame(id) {
  const next = loadLocalGames().filter((row) => row.id !== id);
  save(next);
  return next;
}
