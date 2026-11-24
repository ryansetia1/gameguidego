/**
 * VGMaps (www.vgmaps.com) parsing: the Atlas directory, fuzzy game matching, and the map
 * rows for one game on a platform page. Pure string work, no DOM, so it runs on the server
 * and in `npm run check`. VGMaps HTML is old and loose (uppercase attributes, unquoted
 * values, unclosed cells, nested tables), so every pattern here is case-insensitive and
 * forgiving. Plan: docs/plan/vgmaps-map-viewer.md (section 3A.1).
 *
 * ponytail: regex scanning instead of an HTML parser; a page that breaks it gets a fixture
 * in scripts/check.mjs before anyone reaches for cheerio.
 */

import { platformLabelFor } from "./platforms.js";

export const VGMAPS_ATLAS_URL = "https://www.vgmaps.com/Atlas/index.htm";
export const LARGE_MAP_WARNING_BYTES = 6 * 1024 * 1024;
export const IMAGE_EXTENSIONS = new Set(["png", "gif", "jpg", "jpeg", "webp", "bmp"]);
export const FORMAT_TOKENS = new Set(["PNG", "GIF", "JPG", "JPEG", "WEBP", "BMP"]);
export const SEARCH_STOP_WORDS = new Set(["of", "the", "and", "a", "an"]);
export const SEARCH_METADATA_TOKENS = new Set([
  "usa", "us", "u", "europe", "eur", "e", "japan", "jp", "j", "world", "rev", "revision",
]);
const PLATFORM_BONUS = 120;
const TRAILING_PARENTHETICAL = /\s+\([^)]{1,40}\)\s*$/;
const DIMENSIONS = /\b(\d{2,})\s*x\s*(\d{2,})\b/i;
const FILE_SIZE = /\b(\d+(?:\.\d+)?)\s*(kb|kib|mb|mib|bytes?)\b/i;
const FORMAT = /\b(PNG|GIF|JPE?G|WEBP|BMP)\b/i;
// ponytail: lazy body scan is quadratic on a page full of unclosed <a> tags; phase 2's
// fetch caps the page size before parsing, which is the bound that keeps this cheap.
const LINK = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;

/**
 * @typedef {{ title: string, platform: string, url: string }} VGMapsGameEntry
 * @typedef {{
 *   mapName: string, imageUrl: string, dimensions: string, width: number|null,
 *   height: number|null, fileSize: string, fileSizeBytes: number|null, format: string,
 *   author: string, guideTitle: string, isLarge: boolean,
 * }} VGMapsMapLink
 */

/** @type {Record<string, string>} */
const NAMED_ENTITIES = { amp: "&", nbsp: " ", quot: '"', apos: "'", lt: "<", gt: ">" };

/** @param {string} str */
export function decodeHtmlEntities(str) {
  return String(str ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    const lower = body.toLowerCase();
    if (lower.startsWith("#")) {
      const code = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[lower] ?? whole;
  });
}

/** Tags out, entities decoded, whitespace collapsed. @param {string} html */
export function stripHtmlTags(html) {
  return decodeHtmlEntities(String(html ?? "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** @param {string} hostname */
export function isAllowedVGMapsHost(hostname) {
  const host = String(hostname ?? "").toLowerCase();
  return host === "vgmaps.com" || host === "www.vgmaps.com";
}

/**
 * Resolve a (possibly relative) VGMaps link to an absolute https URL, keeping `#fragment`.
 * Anything off the VGMaps host, with credentials or a custom port, or not http(s) is null,
 * which is the SSRF guard the proxy routes rely on.
 * @param {string|null|undefined} rawUrl @param {string} [baseUrl] @returns {string|null}
 */
export function canonicalVGMapsUrl(rawUrl, baseUrl = VGMAPS_ATLAS_URL) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return null;
  let url;
  try {
    url = new URL(decodeHtmlEntities(rawUrl.trim()), baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.port) return null;
  if (!isAllowedVGMapsHost(url.hostname)) return null;
  url.protocol = "https:";
  return url.href;
}

/** @param {string} pathname */
function extensionOf(pathname) {
  const match = /\.([a-z0-9]+)$/i.exec(pathname);
  return match ? match[1].toLowerCase() : "";
}

/** @param {string|null|undefined} rawUrl */
export function isAllowedVGMapsImageUrl(rawUrl) {
  const url = canonicalVGMapsUrl(rawUrl);
  return url !== null && IMAGE_EXTENSIONS.has(extensionOf(new URL(url).pathname));
}

/** "/Atlas/SNES/index.htm" → "SNES" ("" when the path is not a platform page). @param {string} pathname */
export function extractPlatformFromPath(pathname) {
  const match = /\/atlas\/([^/]+)\/index\.html?$/i.exec(String(pathname ?? ""));
  return match ? safeDecode(match[1]) : "";
}

/** decodeURIComponent that keeps the raw text on a malformed escape. @param {string} text */
function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** @param {string} attrs @param {string} name @returns {string|null} */
function attr(attrs, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

/**
 * Game entries from the Atlas index: links to `<platform>/index.htm#<anchor>`.
 * Deduped by URL, keeping the longer title.
 * @param {string} html @param {string} [baseUrl] @returns {VGMapsGameEntry[]}
 */
export function parseVGMapsDirectory(html, baseUrl = VGMAPS_ATLAS_URL) {
  /** @type {Map<string, VGMapsGameEntry>} */
  const byUrl = new Map();
  for (const [, attrs, inner] of String(html ?? "").matchAll(LINK)) {
    const href = attr(attrs, "href");
    const url = href == null ? null : canonicalVGMapsUrl(href, baseUrl);
    if (!url) continue;
    const parsed = new URL(url);
    if (!/\/index\.htm$/i.test(parsed.pathname) || parsed.hash.length < 2) continue;
    const platform = extractPlatformFromPath(parsed.pathname);
    const title = stripHtmlTags(inner);
    if (!platform || !title) continue;
    const prior = byUrl.get(url);
    if (!prior || title.length > prior.title.length) byUrl.set(url, { title, platform, url });
  }
  return [...byUrl.values()];
}

/** @param {string} text */
export function normalizeSearchText(text) {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['‘’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** @param {string} text @returns {string[]} */
export function tokenizeSearch(text) {
  const stripped = String(text ?? "").replace(TRAILING_PARENTHETICAL, "");
  return normalizeSearchText(stripped)
    .split(" ")
    .filter((t) => t && !SEARCH_STOP_WORDS.has(t) && !SEARCH_METADATA_TOKENS.has(t));
}

/** Normalized, minus a trailing "(USA)"-style tag, stop words and ROM tags. @param {string} text */
export function canonicalSearchText(text) {
  return tokenizeSearch(text).join(" ");
}

/**
 * True when our platform (any spelling) and a VGMaps path segment ("SNES", "GBA") are
 * the same console.
 * @param {string} platform @param {string} vgmapsPlatform
 */
export function platformMatchesVGMaps(platform, vgmapsPlatform) {
  const ours = platformLabelFor(platform);
  return Boolean(ours) && ours === platformLabelFor(vgmapsPlatform);
}

/** @param {string} query @param {VGMapsGameEntry} entry */
function scoreEntry(query, entry) {
  const nq = normalizeSearchText(query);
  const cq = canonicalSearchText(query);
  const ne = normalizeSearchText(entry.title);
  const ce = canonicalSearchText(entry.title);
  const queryTokens = new Set(tokenizeSearch(query));
  const entryTokens = new Set(tokenizeSearch(entry.title));
  let k = 0;
  for (const token of queryTokens) if (entryTokens.has(token)) k += 1;
  const ratio = queryTokens.size ? k / queryTokens.size : 0;
  if (nq && ne === nq) return 1000;
  if (cq && ce === cq) return 950;
  if (nq && ne.includes(nq)) return 800 + k;
  if (cq && ce.includes(cq)) return 750 + k;
  if (queryTokens.size && k === queryTokens.size) return 500 + k;
  if (k >= 2 && ratio >= 0.9) return Math.floor(ratio * 100) + k;
  return 0;
}

/**
 * Best VGMaps entries for a game name. Phase 1: exact (normalized or canonical) title
 * matches, platform matches first. Phase 2: tiered score, +120 when the platform matches.
 * @param {string} query @param {VGMapsGameEntry[]} entries
 * @param {{ platform?: string, limit?: number }} [opts] @returns {VGMapsGameEntry[]}
 */
export function findVGMapsGameMatches(query, entries, { platform = "", limit = 12 } = {}) {
  const nq = normalizeSearchText(query);
  const cq = canonicalSearchText(query);
  if (!nq) return [];
  const affinity = (/** @type {VGMapsGameEntry} */ e) => (platform && platformMatchesVGMaps(platform, e.platform) ? 1 : 0);
  const byTitle = (/** @type {VGMapsGameEntry} */ a, /** @type {VGMapsGameEntry} */ b) =>
    a.title.localeCompare(b.title) || a.platform.localeCompare(b.platform);
  const exact = entries.filter(
    (e) => normalizeSearchText(e.title) === nq || (cq && canonicalSearchText(e.title) === cq),
  );
  if (exact.length) {
    return exact.sort((a, b) => affinity(b) - affinity(a) || byTitle(a, b)).slice(0, limit);
  }
  return entries
    .map((entry) => {
      const base = scoreEntry(query, entry);
      return { entry, score: base > 0 ? base + affinity(entry) * PLATFORM_BONUS : 0 };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || byTitle(a.entry, b.entry))
    .slice(0, limit)
    .map((row) => row.entry);
}

/** "2.5 MB" → 2621440, null when there is no size. @param {string} text @returns {number|null} */
export function parseFileSizeBytes(text) {
  const match = FILE_SIZE.exec(String(text ?? ""));
  if (!match) return null;
  const unit = match[2].toLowerCase();
  const mult = unit.startsWith("m") ? 1048576 : unit.startsWith("k") ? 1024 : 1;
  return Math.round(parseFloat(match[1]) * mult);
}

/** "4096 x 3072" → { width, height }. @param {string} text */
export function parseDimensions(text) {
  const match = DIMENSIONS.exec(String(text ?? ""));
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

/** Game anchors (`<a name>` / `<a id>`) in this html. Ids on cells or images are not anchors. */
const ANCHOR = /<a\b[^>]*?\b(?:name|id)\s*=\s*["']?([^"'\s>]+)/gi;

/** @param {string} html @returns {{ name: string, index: number }[]} %-decoded, lowercased */
function anchorsIn(html) {
  return [...html.matchAll(ANCHOR)].map((m) => ({
    name: safeDecode(decodeHtmlEntities(m[1])).toLowerCase(),
    index: m.index ?? 0,
  }));
}

/** @param {string} html @returns {string[]} */
function anchorNames(html) {
  return anchorsIn(html).map((a) => a.name);
}

/** @param {string} pageUrl @returns {string[]} fragment spellings to match, lowercased */
function fragmentKeys(pageUrl) {
  const hash = /#(.+)$/.exec(String(pageUrl ?? ""))?.[1] ?? "";
  if (!hash) return [];
  return [...new Set([hash.toLowerCase(), safeDecode(hash).toLowerCase()])];
}

/**
 * The `<tr>` chunks that belong to the game named by `#fragment`: from its anchor row
 * until the next game's anchor or the end of the anchor's table. No fragment, or an
 * anchor that isn't on the page, falls back to every row.
 * @param {string} html @param {string} pageUrl @returns {string[]}
 */
export function selectRowsForPage(html, pageUrl) {
  // Chunk 0 is whatever precedes the first <tr>; an anchor may sit there (before a table).
  const chunks = String(html ?? "").split(/(?=<tr\b)/i);
  const rows = chunks.filter((chunk) => /^<tr\b/i.test(chunk));
  const keys = fragmentKeys(pageUrl);
  if (!keys.length) return rows;
  const start = chunks.findIndex((chunk) => anchorNames(chunk).some((name) => keys.includes(name)));
  if (start < 0) return rows;
  // Begin at the anchor itself, so a previous game's cells sharing its chunk are left out.
  const anchor = anchorsIn(chunks[start]).find((a) => keys.includes(a.name));
  const first = chunks[start].slice(anchor?.index ?? 0);
  // Table depth from the anchor on. Anchor inside a table: its table closes at depth -1.
  // Anchor just before a table: that table opens (depth 1) and closes back at 0.
  let depth = 0;
  for (const tag of first.matchAll(/<(\/?)table\b/gi)) depth += tag[1] ? -1 : 1;
  const floor = depth > 0 ? depth - 1 : -1;
  const out = [first];
  for (const row of chunks.slice(start + 1)) {
    if (anchorNames(row).some((name) => !keys.includes(name))) break;
    let cut = -1;
    for (const tag of row.matchAll(/<(\/?)table\b/gi)) {
      depth += tag[1] ? -1 : 1;
      if (depth <= floor) {
        cut = tag.index ?? 0;
        break;
      }
    }
    if (cut >= 0) {
      out.push(row.slice(0, cut));
      break;
    }
    out.push(row);
  }
  return out;
}

/** Text split on line breaks and cell boundaries. @param {string} html @returns {string[]} */
function textLines(html) {
  return String(html ?? "")
    .replace(/<br\s*\/?>|<\/(?:p|div|li)\s*>|<\/?t[dh]\b[^>]*>/gi, "\n")
    .split("\n")
    .map(stripHtmlTags)
    .filter(Boolean);
}

/** @param {string} line */
function isMetadataLine(line) {
  const rest = line
    .replace(new RegExp(DIMENSIONS.source, "gi"), "")
    .replace(new RegExp(FILE_SIZE.source, "gi"), "")
    .replace(new RegExp(FORMAT.source, "gi"), "")
    .replace(/[\s,;:|()[\]-]+/g, "");
  return rest.length === 0;
}

/** "(by Foo)" / "by Foo" / "(Foo)" → "Foo". @param {string[]} lines @param {string} mapName */
function pickAuthor(lines, mapName) {
  for (const line of lines) {
    const by = /\bby\s+(.+?)\)?$/i.exec(line);
    if (by) return by[1].trim();
  }
  for (const line of lines) {
    const paren = /^\((.+)\)$/.exec(line);
    if (paren && !isMetadataLine(paren[1])) return paren[1].trim();
  }
  const rest = lines.filter((line) => line !== mapName && !isMetadataLine(line));
  return rest[0] ?? "";
}

/**
 * Map links for the game named by `pageUrl`'s `#fragment`, with their metadata.
 * Metadata is read from the link's own cell first (grid layouts hold one map per cell);
 * a row with a single map also falls back to the whole row's text.
 * @param {string} html @param {string} pageUrl @returns {VGMapsMapLink[]}
 */
export function extractVGMapsLinks(html, pageUrl) {
  const rows = selectRowsForPage(html, pageUrl);
  const keys = fragmentKeys(pageUrl);
  const anchored = rows.length > 0 && anchorNames(rows[0]).some((name) => keys.includes(name));
  // The anchor row holds the game's title (its map links, if any, are dropped from it).
  const guideTitle = anchored ? stripHtmlTags(rows[0].replace(/<a\b[^>]*\bhref[\s\S]*?<\/a\s*>/gi, "")) : "";
  /** @type {Map<string, VGMapsMapLink>} */
  const byUrl = new Map();
  for (const row of rows) {
    const cells = row.split(/(?=<t[dh]\b)/i).filter((cell) => /^<t[dh]\b/i.test(cell));
    const rowLinks = [...row.matchAll(LINK)].filter(([, attrs]) => isAllowedVGMapsImageUrl(resolveHref(attrs, pageUrl)));
    for (const cell of cells.length ? cells : [row]) {
      for (const [, attrs, inner] of cell.matchAll(LINK)) {
        const imageUrl = resolveHref(attrs, pageUrl)?.replace(/#.*$/, "") ?? null;
        if (!imageUrl || !isAllowedVGMapsImageUrl(imageUrl) || byUrl.has(imageUrl)) continue;
        let lines = textLines(cell);
        const meta = (/** @type {RegExp} */ re) => lines.join(" ").match(re);
        if (rowLinks.length === 1 && !meta(DIMENSIONS) && !meta(FILE_SIZE)) lines = textLines(row);
        const text = lines.join(" ");
        const fileName = safeDecode(new URL(imageUrl).pathname.split("/").pop() || "");
        const linkText = stripHtmlTags(inner);
        const mapName = linkText || lines.find((line) => !isMetadataLine(line)) || fileName.replace(/\.[a-z0-9]+$/i, "");
        const dims = parseDimensions(text);
        const fileSize = FILE_SIZE.exec(text)?.[0] ?? "";
        const fileSizeBytes = parseFileSizeBytes(text);
        const format = (FORMAT.exec(text)?.[1] ?? extensionOf(new URL(imageUrl).pathname)).toUpperCase();
        byUrl.set(imageUrl, {
          mapName,
          imageUrl,
          dimensions: dims ? `${dims.width} x ${dims.height}` : "",
          width: dims?.width ?? null,
          height: dims?.height ?? null,
          fileSize,
          fileSizeBytes,
          format: FORMAT_TOKENS.has(format) ? format : "",
          author: pickAuthor(lines.filter((line) => line !== linkText), mapName),
          guideTitle,
          isLarge: fileSizeBytes != null && fileSizeBytes > LARGE_MAP_WARNING_BYTES,
        });
      }
    }
  }
  return [...byUrl.values()];
}

/** @param {string} attrs @param {string} pageUrl */
function resolveHref(attrs, pageUrl) {
  const href = attr(attrs, "href");
  return href == null ? null : canonicalVGMapsUrl(href, pageUrl);
}
