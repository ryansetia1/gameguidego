/**
 * Pure helpers for the Maps panel (#39): tab defaults, query parsing, plain-text metadata
 * formatting, download progress math, side-panel exclusivity, and back/forward history
 * decisions. Kept DOM-free so `scripts/check.mjs` tests every branch deterministically.
 */

import { MAX_MAP_BLOB_BYTES } from "./map-blob-cache.js";
import { formatDimensionsLabel, formatMegabytes } from "./map-viewport.js";
import { platformLabelFor } from "./platforms.js";

/** @typedef {"saved" | "find"} MapsTab */
/** @typedef {{ gggMaps?: "panel" | "viewer" } | null} MapsHistoryEntry */

// Ambiguous trailing tokens that can belong to a game title rather than a console tag.
const AMBIGUOUS_TRAILING_PLATFORMS = new Set(["360", "one"]);

/**
 * Default active tab when opening Maps for a game: Saved if the game has saved maps,
 * otherwise Find on VGMaps. An explicit in-memory `lastUsedTab` wins when present.
 * @param {number} savedCount
 * @param {MapsTab | null} [lastUsedTab]
 * @returns {MapsTab}
 */
export function defaultMapsTab(savedCount, lastUsedTab = null) {
  if (lastUsedTab === "saved" || lastUsedTab === "find") return lastUsedTab;
  return savedCount > 0 ? "saved" : "find";
}

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
 * Plain-text metadata line for a Find step-2 map row (`4096 × 3072 · 5.2 MB · PNG · Author`).
 * @param {{ width?: number|null, height?: number|null, dimensions?: string, fileSize?: string, format?: string, author?: string }} mapLink
 * @returns {string}
 */
export function formatFindMapMeta(mapLink) {
  const parts = [];
  const dims = formatDimensionsLabel(mapLink?.width, mapLink?.height, mapLink?.dimensions ?? "");
  if (dims) parts.push(dims);
  const size = String(mapLink?.fileSize ?? "").trim();
  if (size) parts.push(size);
  const fmt = String(mapLink?.format ?? "").trim();
  if (fmt) parts.push(fmt);
  const author = String(mapLink?.author ?? "").trim();
  if (author) parts.push(author);
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
 * Mutual-exclusivity helper for the two right-hand side panels (`saved` answers vs `maps`).
 * Guarantees at most one side panel is open at any time.
 * @param {{ savedOpen: boolean, mapsOpen: boolean }} state
 * @param {"open-saved" | "open-maps" | "close-saved" | "close-maps"} action
 * @returns {{ savedOpen: boolean, mapsOpen: boolean }}
 */
export function nextSidePanelState(state, action) {
  if (action === "open-maps") return { savedOpen: false, mapsOpen: true };
  if (action === "open-saved") return { savedOpen: true, mapsOpen: false };
  if (action === "close-maps") return { ...state, mapsOpen: false };
  if (action === "close-saved") return { ...state, savedOpen: false };
  return state;
}

/**
 * Back/forward history decision for `MapViewer` and `MapsPanel` (mirrors `savedPopAction`).
 * Back closes the viewer first, then the panel. Entries pushed above the panel in split
 * mode fall through to `"passthrough"` so chat/overlay back still works.
 *
 * @param {{
 *   panelOpen: boolean,
 *   viewerOpen: boolean,
 *   depth: number,
 *   prevDepth: number,
 *   panelDepth: number,
 *   viewerDepth: number,
 *   left: MapsHistoryEntry,
 *   landing: MapsHistoryEntry,
 * }} p
 * @returns {{ type: "close-viewer" | "close-panel" | "none" | "passthrough" }}
 */
export function mapsPopAction({
  panelOpen,
  viewerOpen,
  depth,
  prevDepth,
  panelDepth,
  viewerDepth,
  left,
  landing,
}) {
  const leftTag = left?.gggMaps;
  const landingTag = landing?.gggMaps;
  const goingForward = depth > prevDepth;

  if (viewerOpen) {
    if (goingForward) return { type: "none" };
    if (leftTag === "viewer" || depth < viewerDepth) return { type: "close-viewer" };
    return { type: "passthrough" };
  }

  if (panelOpen) {
    if (goingForward) return { type: "none" };
    if (depth < panelDepth) return { type: "close-panel" };
    if (leftTag === "panel") return { type: "close-panel" };
    return { type: "passthrough" };
  }

  // Neither panel nor viewer is open: leftover gggMaps entries are inert.
  if (leftTag || (landingTag && goingForward)) return { type: "none" };
  return { type: "passthrough" };
}
