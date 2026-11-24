import { getServerClient, getServiceClient } from "./supabase-server.js";
import {
  VGMAPS_ATLAS_URL,
  canonicalVGMapsUrl,
  extractVGMapsLinks,
  isAllowedVGMapsImageUrl,
  parseVGMapsDirectory,
  type VGMapsGameEntry,
  type VGMapsMapLink,
} from "./vgmaps-parser.js";

// Server-only VGMaps fetch + 7-day read-through cache (plan 3A.5, mirrors lib/hltb-cache.js).
// Every upstream request goes through fetchVGMaps: redirects are followed by hand and each
// hop is re-validated against the VGMaps allowlist, so a redirect can't point the server
// at another host (SSRF). Page bodies are size-capped BEFORE the parser sees them.

export const VGMAPS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The Atlas index is ~2 MB and the NES page ~6 MB; well past that isn't a page we parse. */
export const MAX_PAGE_BYTES = 16 * 1024 * 1024;
export const MAX_MAP_BYTES = 30 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const PAGE_TIMEOUT_MS = 15_000;
const IMAGE_TIMEOUT_MS = 25_000;
const UA = "GameGuideGo/1.0 (+https://gameguidego.vercel.app)";
/** Raster types only: an image/svg+xml body could run script on our origin. */
const IMAGE_TYPES = new Set(["image/png", "image/gif", "image/jpeg", "image/webp", "image/bmp", "image/x-ms-bmp"]);

/** An upstream failure the routes turn into an HTTP status (400 / 413 / 502). */
export class VGMapsError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** url → its canonical https form, or null when the hop isn't allowed. */
type HopGuard = (url: string) => string | null;

const pageGuard: HopGuard = (url) => canonicalVGMapsUrl(url);
const imageGuard: HopGuard = (url) => (isAllowedVGMapsImageUrl(url) ? canonicalVGMapsUrl(url) : null);

/**
 * GET a VGMaps URL with `redirect: "manual"`, re-validating every hop with `guard`.
 * @throws VGMapsError 400 for a blocked start URL, 502 for a blocked/looping redirect.
 */
export async function fetchVGMaps(
  rawUrl: string,
  { guard, accept, referer, timeoutMs }: { guard: HopGuard; accept: string; referer?: string; timeoutMs: number },
): Promise<Response> {
  const start = guard(rawUrl);
  if (!start) throw new VGMapsError("Not a VGMaps URL.", 400);
  let url: string = start;
  const signal = AbortSignal.timeout(timeoutMs);
  for (let hop = 0; ; hop++) {
    const res: Response = await fetch(url.replace(/#.*$/, ""), {
      headers: { "User-Agent": UA, Accept: accept, ...(referer ? { Referer: referer } : {}) },
      redirect: "manual",
      cache: "no-store",
      signal,
    });
    if (res.status < 300 || res.status > 399) return res;
    await res.body?.cancel();
    const location: string | null = res.headers.get("location");
    const next: string | null = location && hop < MAX_REDIRECTS ? guard(new URL(location, url).href) : null;
    if (!next) throw new VGMapsError("VGMaps redirected somewhere we don't follow.", 502);
    url = next;
  }
}

/** Throws 413 when the declared Content-Length is over `max`. */
function assertDeclaredSize(res: Response, max: number) {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    void res.body?.cancel();
    throw new VGMapsError("Too large.", 413);
  }
}

/** Read the whole body, stopping (413) as soon as it passes `max` bytes. */
export async function readCappedBody(res: Response, max: number): Promise<Uint8Array> {
  assertDeclaredSize(res, max);
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new VGMapsError("Too large.", 413);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** Pass `body` through, erroring the stream once it passes `max` bytes. */
export function capStream(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > max) controller.error(new VGMapsError("Too large.", 413));
        else controller.enqueue(chunk);
      },
    }),
  );
}

/** @param contentType header value; falls back to utf-8 for a missing/unknown charset. */
function decode(bytes: Uint8Array, contentType: string) {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/** One VGMaps html page as text, capped at MAX_PAGE_BYTES (413) before anything parses it. */
export async function fetchVGMapsText(url: string): Promise<string> {
  const res = await fetchVGMaps(url, { guard: pageGuard, accept: "text/html", timeoutMs: PAGE_TIMEOUT_MS });
  if (!res.ok) {
    await res.body?.cancel();
    throw new VGMapsError(`VGMaps returned ${res.status}.`, 502);
  }
  return decode(await readCappedBody(res, MAX_PAGE_BYTES), res.headers.get("content-type") ?? "");
}

/**
 * Upstream map image for the proxy route: validated, raster-only, streamed with a byte cap.
 * @throws VGMapsError 400 bad URL, 413 over MAX_MAP_BYTES (declared), 502 upstream/type.
 */
export async function fetchVGMapsImage(imageUrl: string, referer: string) {
  const res = await fetchVGMaps(imageUrl, {
    guard: imageGuard,
    accept: "image/*",
    referer,
    timeoutMs: IMAGE_TIMEOUT_MS,
  });
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    throw new VGMapsError(`VGMaps returned ${res.status}.`, 502);
  }
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!IMAGE_TYPES.has(contentType)) {
    await res.body.cancel();
    throw new VGMapsError("VGMaps didn't send an image.", 502);
  }
  assertDeclaredSize(res, MAX_MAP_BYTES);
  // ponytail: a body with no Content-Length is streamed and cut at the cap mid-stream (the
  // client sees a failed download, not a 413). Buffering would give a clean 413 but holds
  // up to 30 MB per request and hits the platform's buffered-response limit.
  return {
    body: capStream(res.body, MAX_MAP_BYTES),
    contentType,
    contentLength: res.headers.get("content-length"),
  };
}

type Cached<T> = { data: T; fetchedAt: number };

// Per-instance L1, and the only cache when Supabase is unset or the table is missing.
// Holds the parsed index (~1 MB) and small per-game map lists; only 2xx pages get here.
// ponytail: unbounded entry count, fine at VGMaps' few thousand games; add LRU if it grows.
const memory = new Map<string, Cached<unknown>>();

const isFresh = (row: Cached<unknown>, now: number) =>
  row.fetchedAt > 0 && now - row.fetchedAt < VGMAPS_TTL_MS;

async function readRow<T>(key: string): Promise<Cached<T> | null> {
  const supabase = getServerClient();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("vgmaps_cache")
      .select("data, fetched_at")
      .eq("cache_key", key)
      .maybeSingle();
    if (error || !data) return null;
    return { data: data.data as T, fetchedAt: Date.parse(data.fetched_at) || 0 };
  } catch {
    return null;
  }
}

async function writeRow(key: string, data: unknown, fetchedAt: number) {
  // Service role only: the table has no anon write policy, so the public can't poison it.
  const supabase = getServiceClient();
  if (!supabase) return;
  try {
    await supabase
      .from("vgmaps_cache")
      .upsert({ cache_key: key, data, fetched_at: new Date(fetchedAt).toISOString() });
  } catch {
    // Best-effort: the response still returns when the cache write fails.
  }
}

/**
 * Memory → Supabase → upstream. A failed upstream load falls back to a stale copy.
 * `valid` rejects a cached value of the wrong shape (treated as a miss).
 */
async function readThrough<T>(key: string, load: () => Promise<T>, valid: (data: unknown) => data is T): Promise<T> {
  const now = Date.now();
  const mem = memory.get(key) as Cached<T> | undefined;
  if (mem && isFresh(mem, now)) return mem.data;
  const row = await readRow<T>(key);
  const stored = row && valid(row.data) ? row : null;
  if (stored && isFresh(stored, now)) {
    memory.set(key, stored);
    return stored.data;
  }
  let data: T;
  try {
    data = await load();
  } catch (err) {
    const stale = mem ?? stored;
    if (stale) return stale.data;
    throw err;
  }
  memory.set(key, { data, fetchedAt: now });
  await writeRow(key, data, now);
  return data;
}

const isEntryList = (data: unknown): data is VGMapsGameEntry[] =>
  Array.isArray(data) &&
  data.every((e) => e && typeof e.title === "string" && typeof e.platform === "string" && typeof e.url === "string");

/** Parsed Atlas index (game entries), cached under "atlas:index". */
export async function getCachedVGMapsDirectory(): Promise<VGMapsGameEntry[]> {
  const entries = await readThrough(
    "atlas:index",
    async () => {
      const parsed = parseVGMapsDirectory(await fetchVGMapsText(VGMAPS_ATLAS_URL));
      // An empty parse means the page changed or broke; don't cache that for a week.
      if (!parsed.length) throw new VGMapsError("VGMaps index had no games.", 502);
      return parsed;
    },
    isEntryList,
  );
  // Re-check URLs on the way out so a bad cached row can't hand the client an off-site link.
  return entries.filter((entry) => canonicalVGMapsUrl(entry.url) !== null);
}

// Raw platform pages run up to ~6 MB, too big for a cache row, so html stays in memory
// (a few pages per instance) and only each game's parsed map list is stored.
const PAGE_MEMORY_LIMIT = 6;
const pages = new Map<string, Cached<string>>();

async function pageHtml(page: string): Promise<string> {
  const hit = pages.get(page);
  if (hit && isFresh(hit, Date.now())) return hit.data;
  const html = await fetchVGMapsText(page);
  pages.delete(page);
  pages.set(page, { data: html, fetchedAt: Date.now() });
  if (pages.size > PAGE_MEMORY_LIMIT) pages.delete(pages.keys().next().value as string);
  return html;
}

const isMapList = (data: unknown): data is VGMapsMapLink[] =>
  Array.isArray(data) && data.every((m) => m && typeof m.mapName === "string" && typeof m.imageUrl === "string");

/**
 * Map links for one game (`<platform page>#<anchor>`), cached under "maps:<canonical url>".
 * Every anchor on a platform page shares one in-memory copy of that page's html.
 */
export async function getCachedVGMapsMaps(gameUrl: string): Promise<VGMapsMapLink[]> {
  const canonical = canonicalVGMapsUrl(gameUrl);
  if (!canonical) throw new VGMapsError("Not a VGMaps URL.", 400);
  const { origin, pathname } = new URL(canonical);
  const maps = await readThrough(
    `maps:${canonical}`,
    async () => extractVGMapsLinks(await pageHtml(origin + pathname), canonical),
    isMapList,
  );
  return maps.filter((map) => isAllowedVGMapsImageUrl(map.imageUrl));
}
