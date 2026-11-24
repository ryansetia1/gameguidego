/**
 * Pure helpers for the Maps panel (#39, #56): query parsing, filter, staged loading text,
 * game auto-resolve, plain-text metadata formatting, download progress math, and
 * back/forward history decisions. Kept DOM-free so `scripts/check.mjs` tests every branch deterministically.
 */

import { MAX_MAP_BLOB_BYTES } from "./map-blob-cache.js";
import { formatDimensionsLabel, formatMegabytes } from "./map-viewport.js";
import { platformLabelFor } from "./platforms.js";
import { canonicalSearchText, normalizeSearchText, platformMatchesVGMaps } from "./vgmaps-parser.js";

/** @typedef {{ gggMaps?: "panel" | "picker" | "viewer" } | null} MapsHistoryEntry */
/** @typedef {{ title: string, platform: string, url: string }} VGMapsGameEntry */

// Ambiguous trailing tokens that can belong to a game title rather than a console tag.
const AMBIGUOUS_TRAILING_PLATFORMS = new Set(["360", "one"]);

/** A stage that makes no progress for this long shows "VGMaps is slow right now" + Cancel. */
export const MAPS_SLOW_MS = 6000;
/** A stage still running after this long gives up with "Couldn't reach VGMaps." */
export const MAPS_TIMEOUT_MS = 20000;
/** Most rows the "Which game?" list shows. */
export const MAPS_PICK_MAX = 6;

/**
 * Prefilled search query (`game + platform`) for the Find on VGMaps box.
 * @param {string} game
 * @param {string} [platform]
 * @returns {string}
 */
export function defaultMapsQuery(game, platform = "") {
  return [String(game ?? "").trim(), String(platform ?? "").trim()].filter(Boolean).join(" ");
}

/**
 * Split a user-editable Find query into `{ game, platform }` for `/api/maps/search`.
 * `/api/maps/search` matches `game` strictly against VGMaps entry titles and uses `platform`
 * as an affinity bonus, so keeping a trailing console name attached to `game` would miss
 * exact titles like "Chrono Trigger".
 * @param {string} rawQuery
 * @param {string} [activeGame]
 * @param {string} [activePlatform]
 * @returns {{ game: string, platform: string }}
 */
export function parseMapsSearchQuery(rawQuery, activeGame = "", activePlatform = "") {
  const trimmed = String(rawQuery ?? "").trim();
  const baseGame = String(activeGame ?? "").trim();
  const basePlatform = String(activePlatform ?? "").trim();
  if (!trimmed) return { game: "", platform: "" };

  const prefilled = defaultMapsQuery(baseGame, basePlatform);
  if (prefilled && trimmed.toLowerCase() === prefilled.toLowerCase()) {
    return { game: baseGame, platform: basePlatform };
  }

  if (basePlatform) {
    const suffix = basePlatform.toLowerCase();
    const lower = trimmed.toLowerCase();
    if (lower.length > suffix.length && lower.endsWith(suffix)) {
      const before = trimmed.slice(0, trimmed.length - suffix.length);
      if (/\s+$/.test(before) && before.trim()) {
        return { game: before.trim(), platform: basePlatform };
      }
    }
  }

  const norm = (/** @type {string} */ s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const tokens = trimmed.split(/\s+/);
  const maxLen = Math.min(5, tokens.length - 1);
  for (let len = 1; len <= maxLen; len += 1) {
    const tail = tokens.slice(-len).join(" ");
    if (len === 1 && AMBIGUOUS_TRAILING_PLATFORMS.has(tail.toLowerCase())) continue;
    const label = platformLabelFor(tail);
    if (!label) continue;
    // Expand left only if the wider suffix matches the canonical platform label itself
    // (e.g. "Nintendo Switch 2" after matching "Switch 2", or "PlayStation (PS1)" after "(PS1)").
    let bestLen = len;
    const normLabel = norm(label);
    for (let wider = len + 1; wider <= maxLen; wider += 1) {
      const widerTail = tokens.slice(-wider).join(" ");
      if (norm(widerTail) === normLabel) bestLen = wider;
    }
    const head = tokens.slice(0, -bestLen).join(" ").trim();
    if (head) return { game: head, platform: label };
  }

  return { game: trimmed, platform: basePlatform };
}

/**
 * Plain-text metadata line for a Saved tab row (`" · "` separated, skipping missing parts).
 * @param {{ width?: number|null, height?: number|null, dimensions?: string, fileSize?: string, author?: string, synced?: boolean }} item
 * @param {{ cached?: boolean|null, signedIn?: boolean, syncAvailable?: boolean, syncFailed?: boolean }} [opts]
 * @returns {string}
 */
export function formatSavedMapMeta(
  item,
  { cached = null, signedIn = false, syncAvailable = false, syncFailed = false } = {},
) {
  const parts = [];
  const dims = formatDimensionsLabel(item?.width, item?.height, item?.dimensions ?? "");
  if (dims) parts.push(dims);
  const size = String(item?.fileSize ?? "").trim();
  if (size) parts.push(size);
  const author = String(item?.author ?? "").trim();
  if (author) parts.push(author);
  if (cached === true) parts.push("On this device");
  else if (cached === false) parts.push("Not downloaded");
  if (signedIn && syncAvailable && syncFailed && !item?.synced) {
    parts.push("Not synced yet");
  }
  return parts.join(" · ");
}

/**
 * Plain-text metadata line for an "On VGMaps" row (`4096 × 3072 · 5.2 MB · Author`), ending
 * with "On this device" when the map is already saved.
 * @param {{ width?: number|null, height?: number|null, dimensions?: string, fileSize?: string, author?: string }} mapLink
 * @param {{ saved?: boolean }} [opts]
 * @returns {string}
 */
export function formatFindMapMeta(mapLink, { saved = false } = {}) {
  const parts = [];
  const dims = formatDimensionsLabel(mapLink?.width, mapLink?.height, mapLink?.dimensions ?? "");
  if (dims) parts.push(dims);
  const size = String(mapLink?.fileSize ?? "").trim();
  if (size) parts.push(size);
  const author = String(mapLink?.author ?? "").trim();
  if (author) parts.push(author);
  if (saved) parts.push("On this device");
  return parts.join(" · ");
}

/**
 * Whether a VGMaps map exceeds the 30 MB proxy/device limit.
 * @param {{ fileSizeBytes?: number|null }} mapLink
 * @returns {boolean}
 */
export function isMapOverLimit(mapLink) {
  const bytes = mapLink?.fileSizeBytes;
  return typeof bytes === "number" && Number.isFinite(bytes) && bytes > MAX_MAP_BLOB_BYTES;
}

/**
 * Progress text while downloading a map in a Find row.
 * @param {{ loaded: number, total: number | null } | null | undefined} progress
 * @returns {string}
 */
export function formatDownloadProgressText(progress) {
  if (progress && progress.total && progress.total > 0) {
    return `Downloading ${formatMegabytes(progress.loaded)} / ${formatMegabytes(progress.total)} MB`;
  }
  if (progress && progress.loaded > 0) {
    return `Downloading ${formatMegabytes(progress.loaded)} MB`;
  }
  return "Downloading…";
}

/**
 * "Saving 43%" for a map that is downloading into the device cache (row meta line and the
 * viewer's Save slot); "Saving…" until the size is known.
 * @param {{ loaded: number, total: number | null } | null | undefined} progress
 * @returns {string}
 */
export function formatSavingText(progress) {
  if (progress && progress.total && progress.total > 0) {
    return `Saving ${Math.min(100, Math.floor((progress.loaded / progress.total) * 100))}%`;
  }
  return "Saving…";
}

/**
 * Normalized `[0, 1]` scaleX value for the square progress fill bar.
 * @param {{ loaded: number, total: number | null } | null | undefined} progress
 * @returns {number}
 */
export function downloadProgressRatio(progress) {
  if (progress && progress.total && progress.total > 0) {
    return Math.min(1, Math.max(0, progress.loaded / progress.total));
  }
  return 0.15;
}

/**
 * Whether a map row matches the panel filter: case-insensitive substring over its name,
 * area and author, instant (no debounce). An empty query matches everything.
 * @param {{ title?: string, mapName?: string, area?: string, author?: string }} item
 * @param {string} query
 */
export function mapMatchesFilter(item, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return true;
  return [item?.title, item?.mapName, item?.area, item?.author].some((field) =>
    String(field ?? "").toLowerCase().includes(q),
  );
}

/**
 * Filter both panel sections at once and report the "12 of 14 maps" count.
 * @template S, V
 * @param {{ saved: S[], vgmaps: V[], query: string }} p
 * @returns {{ saved: S[], vgmaps: V[], shown: number, total: number, filtering: boolean, countText: string }}
 */
export function filterMapsSections({ saved, vgmaps, query }) {
  const filtering = String(query ?? "").trim() !== "";
  const keep = (/** @type {any} */ item) => mapMatchesFilter(item, query);
  const s = filtering ? saved.filter(keep) : saved;
  const v = filtering ? vgmaps.filter(keep) : vgmaps;
  const total = saved.length + vgmaps.length;
  const shown = s.length + v.length;
  return {
    saved: s,
    vgmaps: v,
    shown,
    total,
    filtering,
    countText: filtering ? `${shown} of ${total} ${total === 1 ? "map" : "maps"}` : "",
  };
}

/**
 * Staged loading for the "On VGMaps" section. The bar follows the real calls: the search
 * call is 1/3, the list call 2/3; the block is replaced by the rows once the list parses.
 * `elapsedMs` counts from the start of the current stage.
 * @param {"search" | "list"} stage
 * @param {{ gameTitle?: string, elapsedMs?: number }} [opts]
 * @returns {{ ratio: number, text: string, slow: boolean, timedOut: boolean }}
 */
export function mapsLoadStage(stage, { gameTitle = "", elapsedMs = 0 } = {}) {
  const slow = elapsedMs >= MAPS_SLOW_MS;
  const timedOut = elapsedMs >= MAPS_TIMEOUT_MS;
  if (stage === "list") {
    const title = String(gameTitle ?? "").trim();
    return {
      ratio: 0.66,
      text: title ? `Found ${title}. Reading its map list…` : "Reading the map list…",
      slow,
      timedOut,
    };
  }
  return { ratio: 0.33, text: "Finding the game on VGMaps…", slow, timedOut };
}

/**
 * Decide whether the active game auto-resolves to one VGMaps entry or needs a
 * "Which game?" pick. Resolves only when the match is unambiguous:
 * 1. a remembered choice for this game + platform (no guessing at all);
 * 2. exactly one exact title match (normalized or canonical), or one exact match on the
 *    active platform when several exact titles exist on different consoles;
 * 3. a single search result (unique).
 * Everything else ("Zelda", "Zelda II", Japanese titles) asks, with up to six options,
 * even when only one fuzzy match is on the active platform: a wrong guess costs a
 * download, one tap costs nothing and is remembered.
 * @param {string} query the game name searched for
 * @param {string} platform the active platform ("" when unknown)
 * @param {VGMapsGameEntry[]} games search results, best first
 * @returns {{ type: "resolved", entry: VGMapsGameEntry } | { type: "pick", options: VGMapsGameEntry[] } | { type: "none" }}
 */
export function resolveMapsGame(query, platform, games) {
  const list = Array.isArray(games) ? games.filter((g) => g && g.url) : [];
  if (list.length === 0) return { type: "none" };
  const onPlatform = (/** @type {VGMapsGameEntry[]} */ rows) =>
    platform ? rows.filter((g) => platformMatchesVGMaps(platform, g.platform)) : [];
  const nq = normalizeSearchText(query);
  const cq = canonicalSearchText(query);
  const exact = list.filter(
    (g) => (nq && normalizeSearchText(g.title) === nq) || (cq && canonicalSearchText(g.title) === cq),
  );
  if (exact.length === 1) return { type: "resolved", entry: exact[0] };
  if (exact.length > 1) {
    const exactHere = onPlatform(exact);
    if (exactHere.length === 1) return { type: "resolved", entry: exactHere[0] };
    return { type: "pick", options: exact.slice(0, MAPS_PICK_MAX) };
  }
  if (list.length === 1) return { type: "resolved", entry: list[0] };
  return { type: "pick", options: list.slice(0, MAPS_PICK_MAX) };
}

/**
 * Storage key for the remembered "Which game?" choice (device-only, per game + platform).
 * @param {string} game @param {string} [platform]
 */
export function mapsChoiceKey(game, platform = "") {
  return `${normalizeSearchText(game)}|${normalizeSearchText(platform)}`;
}

/**
 * Back/forward history decision for the Maps panel (mirrors `savedPopAction`).
 * Entries stack as `panel` → (optional) `picker` → `viewer`; Back pops exactly one:
 * viewer → list, picker → list, list → chat. A multi-step Back below the panel closes it.
 * Entries pushed above the panel in split mode fall through to `"passthrough"` so
 * chat/overlay back still works.
 *
 * @param {{
 *   panelOpen: boolean,
 *   pickerOpen?: boolean,
 *   viewerOpen: boolean,
 *   depth: number,
 *   prevDepth: number,
 *   panelDepth: number,
 *   pickerDepth?: number,
 *   viewerDepth: number,
 *   left: MapsHistoryEntry,
 *   landing: MapsHistoryEntry,
 * }} p
 * @returns {{ type: "close-viewer" | "close-picker" | "close-panel" | "none" | "passthrough" }}
 */
export function mapsPopAction({
  panelOpen,
  pickerOpen = false,
  viewerOpen,
  depth,
  prevDepth,
  panelDepth,
  pickerDepth = 0,
  viewerDepth,
  left,
  landing,
}) {
  const leftTag = left?.gggMaps;
  const landingTag = landing?.gggMaps;
  const goingForward = depth > prevDepth;

  if (panelOpen || viewerOpen) {
    if (goingForward) return { type: "none" };
    if (panelOpen && depth < panelDepth) return { type: "close-panel" };
    if (viewerOpen && (leftTag === "viewer" || depth < viewerDepth)) return { type: "close-viewer" };
    if (pickerOpen && (leftTag === "picker" || depth < pickerDepth)) return { type: "close-picker" };
    if (panelOpen && leftTag === "panel") return { type: "close-panel" };
    return { type: "passthrough" };
  }

  // Neither panel nor viewer is open: leftover gggMaps entries are inert.
  if (leftTag || (landingTag && goingForward)) return { type: "none" };
  return { type: "passthrough" };
}
