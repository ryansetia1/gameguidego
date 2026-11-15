/**
 * @typedef {{ id: number, name: string, year: string, releaseDate: string, cover: string, platform: string, hint?: string }} Game
 */

// IGDB game_type: keep Main(0), Standalone expansion(4), Remake(8), Remaster(9),
// Expanded(10), Port(11). Drops DLC, bundles, mods (ROM hacks), episodes, packs.
export const IGDB_GAME_TYPES = [0, 4, 8, 9, 10, 11];

// catalog_game_id is stored in an int4 column that already holds TheGamesDB ids.
// Offsetting IGDB ids keeps the two id spaces disjoint, so an old TGDB id can never
// collide with an IGDB one and open the wrong game's journal.
export const IGDB_ID_OFFSET = 1_000_000_000;

const IGDB_COVER_URL = "https://images.igdb.com/igdb/image/upload/t_cover_big/";

/**
 * Map an IGDB `/v4/games` payload (fields: name, first_release_date, cover.image_id,
 * platforms.name) into the UI shape. One row per platform, so a multi-console game
 * lists once per console (the autocomplete groups by platform). Drops entries with
 * no id or title; a game with no platforms yields a single row with platform "".
 * `id` is the offset IGDB game id (shared by that game's platform rows).
 *
 * @param {unknown} payload
 * @returns {Game[]}
 */
export function mapIgdbGames(payload) {
  if (!Array.isArray(payload)) return [];

  return payload.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { id, name: rawName, first_release_date: ts, cover, platforms } = /** @type {any} */ (entry);
    if (typeof id !== "number" || typeof rawName !== "string") return [];
    const name = rawName.trim();
    if (!name) return [];

    const date = typeof ts === "number" && Number.isFinite(ts) ? new Date(ts * 1000) : null;
    const releaseDate = date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : "";
    const year = releaseDate.slice(0, 4);
    const imageId = typeof cover?.image_id === "string" ? cover.image_id : "";
    const coverUrl = imageId ? `${IGDB_COVER_URL}${imageId}.jpg` : "";

    const names = (Array.isArray(platforms) ? platforms : [])
      .map((p) => (p && typeof p.name === "string" ? p.name : ""))
      .filter(Boolean);
    return (names.length ? names : [""]).map((platform) => ({
      id: IGDB_ID_OFFSET + id,
      name,
      year,
      releaseDate,
      cover: coverUrl,
      platform,
    }));
  });
}

/** @param {string} name */
function normName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** @param {Game} game */
function groupKey(game) {
  return `${normName(game.name)}|${game.platform}|${game.year}`;
}

/** @param {string} releaseDate ISO YYYY-MM-DD */
export function formatReleaseHint(releaseDate) {
  if (!releaseDate || releaseDate.length < 10) return "";
  const d = new Date(`${releaseDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Prefer a row with cover art, then the lower id. */
function pickBetter(/** @type {Game} */ a, /** @type {Game} */ b) {
  if (Boolean(a.cover) !== Boolean(b.cover)) return a.cover ? a : b;
  return a.id < b.id ? a : b;
}

/**
 * Collapse noisy duplicate rows and attach a short hint when rows under the
 * same name · platform · year still need disambiguation (usually release date).
 *
 * @param {Game[]} games
 * @returns {Game[]}
 */
export function prepareAutocompleteGames(games) {
  /** @type {Map<string, Game[]>} */
  const groups = new Map();
  for (const game of games) {
    const key = groupKey(game);
    const bucket = groups.get(key) ?? [];
    if (!groups.has(key)) groups.set(key, bucket);
    bucket.push(game);
  }

  /** @type {Game[]} */
  const out = [];
  for (const items of groups.values()) {
    if (items.length === 1) {
      out.push({ ...items[0], hint: "" });
      continue;
    }

    // Same title/platform/year: collapse identical release date + cover rows.
    /** @type {Map<string, Game>} */
    const buckets = new Map();
    for (const game of items) {
      const dupKey = `${game.releaseDate}|${game.cover}`;
      const prev = buckets.get(dupKey);
      buckets.set(dupKey, prev ? pickBetter(game, prev) : game);
    }
    let uniq = [...buckets.values()];
    if (uniq.length === 1) {
      out.push({ ...uniq[0], hint: "" });
      continue;
    }

    const dates = [...new Set(uniq.map((g) => g.releaseDate).filter(Boolean))];
    if (dates.length > 1) {
      uniq = uniq.map((game) => ({
        ...game,
        hint: game.releaseDate ? formatReleaseHint(game.releaseDate) : "Release date unknown",
      }));
    } else {
      uniq = uniq.map((game) => ({ ...game, hint: "" }));
    }
    out.push(...uniq);
  }

  // id alone is not unique (one game, many platform rows), so key on id + platform.
  const rowKey = (/** @type {Game} */ g) => `${g.id}|${g.platform}`;
  const order = new Map(games.map((game, index) => [rowKey(game), index]));
  out.sort((a, b) => (order.get(rowKey(a)) ?? 0) - (order.get(rowKey(b)) ?? 0));
  return out;
}
