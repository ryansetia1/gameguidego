import { cleanSnippet } from "@/lib/clean";
import { buildGuideDiscoveryQuery } from "@/lib/guide-search.js";
import { selectSources } from "@/lib/rank";
import { logTraceEvent } from "@/lib/trace";

const TAVILY_URL = "https://api.tavily.com/search";
const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";

/** Server log prefix — grep-friendly when Tavily quota/outage breaks search or ingest. */
function logTavily(
  operation: "search" | "extract",
  message: string,
  extra?: Record<string, unknown>,
): void {
  console.error(`Tavily ${operation} failed: ${message}`, extra ?? "");
}

async function tavilyResponseDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.replace(/\s+/g, " ").trim().slice(0, 240);
  } catch {
    return "";
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

// Per-call timeout combined with an optional caller signal (client Stop), so a
// Stop mid-search aborts the outstanding provider request instead of waiting it out.
function combineSignal(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

export type SearchResult = {
  title: string;
  url: string;
  content: string;
  score: number;
  preferred?: boolean;
};

// Video/social results the text LLM cannot read; always excluded.
const EXCLUDE_DOMAINS = [
  "youtube.com",
  "m.youtube.com",
  "youtu.be",
  "twitch.tv",
  "tiktok.com",
  "instagram.com",
  "facebook.com",
  "x.com",
  "twitter.com",
  "pinterest.com",
];

// Searched in order, stopping once enough results are collected. GameFAQs is the
// primary source, then trusted text walkthrough providers, then forums, then the
// open web as a last resort.
const TIERS: string[][] = [
  ["gamefaqs.gamespot.com"],
  [
    "ign.com",
    "gamespot.com",
    "game8.co",
    "powerpyx.com",
    "fextralife.com",
    "polygon.com",
    "gamesradar.com",
    "neoseeker.com",
    "primagames.com",
    "gameskinny.com",
  ],
  ["reddit.com", "steamcommunity.com", "gamefaqs.gamespot.com"],
  [],
];

// Enough collected results to stop querying further tiers; final relevance
// gating/trimming happens in selectSources.
const MIN_RESULTS = 3;
const CONTENT_CAP = 800;
// Snippets shorter than this after cleaning are almost always pure navigation.
const MIN_CONTENT = 60;

async function runSearch(
  apiKey: string,
  query: string,
  includeDomains: string[],
  signal?: AbortSignal,
  maxResults = 5,
): Promise<SearchResult[]> {
  const start = Date.now();
  void logTraceEvent("tavily_search_start", `Tavily Search: ${query}`, undefined, { query, includeDomains, maxResults });

  const response = await fetch(TAVILY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      // "advanced" extracts more relevant page chunks and re-ranks better than
      // "basic" (which let an unrelated game outrank the correct guides).
      search_depth: "advanced",
      max_results: maxResults,
      include_answer: false,
      exclude_domains: EXCLUDE_DOMAINS,
      ...(includeDomains.length ? { include_domains: includeDomains } : {}),
    }),
    signal: combineSignal(12_000, signal),
  });

  const latency = Date.now() - start;
  void logTraceEvent("tavily_search_end", `Tavily Search Complete (Status ${response.status})`, latency, { status: response.status });

  if (!response.ok) {
    const detail = await tavilyResponseDetail(response);
    const message = `HTTP ${response.status}${detail ? `: ${detail}` : ""}`;
    logTavily("search", message, {
      query: query.slice(0, 120),
      domains: includeDomains.length ? includeDomains : ["open web"],
    });
    throw new Error(`Tavily search failed with status ${response.status}`);
  }

  const payload: unknown = await response.json();
  const results =
    payload && typeof payload === "object" && "results" in payload
      ? (payload.results as unknown)
      : null;

  if (!Array.isArray(results)) return [];

  return results.flatMap((result): SearchResult[] => {
    if (
      !result ||
      typeof result !== "object" ||
      !("title" in result) ||
      !("url" in result) ||
      !("content" in result) ||
      typeof result.title !== "string" ||
      typeof result.url !== "string" ||
      typeof result.content !== "string"
    ) {
      return [];
    }

    try {
      const url = new URL(result.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") return [];

      const content = cleanSnippet(result.content).slice(0, CONTENT_CAP);
      if (content.length < MIN_CONTENT) return [];

      const score =
        "score" in result && typeof result.score === "number"
          ? result.score
          : 0;

      return [
        {
          title: cleanSnippet(result.title) || url.hostname,
          url: url.toString(),
          content,
          score,
        },
      ];
    } catch {
      return [];
    }
  });
}

// WordPress-style listing/hub paths that only carry teasers + "Read more" links,
// not the actual walkthrough text. ponytail: path-pattern heuristic, not a content
// check; extend the list if a site uses other archive prefixes.
function looksLikeIndex(rawUrl: string): boolean {
  try {
    const path = new URL(rawUrl).pathname;
    return /\/(category|categories|tag|tags|author|archives?|page)\//i.test(path);
  } catch {
    return false;
  }
}

// Site root or archive listing — not a full walkthrough page.
export function looksLikeHub(rawUrl: string): boolean {
  try {
    const path = new URL(rawUrl).pathname.replace(/\/+$/, "") || "/";
    if (path === "/") return true;
    return looksLikeIndex(rawUrl);
  } catch {
    return true;
  }
}

export function isBlockedGuideContent(text: string): boolean {
  return /Social Media Cookies|Just a moment|challenges\.cloudflare|Enable JavaScript and cookies to continue|Please stand by, while we are checking your browser|Cloudflare Ray ID|cf-browser-verification|DDoS protection by Cloudflare/i.test(
    text,
  );
}

const EXTRACT_BATCH_SIZE = 10;

type TavilyExtractDepth = "basic" | "advanced";

function mergeExtractResults(
  target: Map<string, string>,
  results: unknown,
  // Discovery needs RAW markdown: the GameFAQs sidebar TOC is a set of
  // [label](…/faqs/id/slug) links, and cleanSnippet strips every URL — so parsing
  // the TOC out of cleaned text silently finds nothing. Ingest keeps cleaned text.
  raw = false,
): void {
  if (!Array.isArray(results)) return;
  for (const item of results) {
    if (!item || typeof item !== "object") continue;
    const record = item as { url?: unknown; raw_content?: unknown };
    if (typeof record.url !== "string" || typeof record.raw_content !== "string") continue;
    const content = raw ? record.raw_content : cleanSnippet(record.raw_content);
    if (content.length < MIN_CONTENT) continue;
    try {
      target.set(new URL(record.url).toString(), content);
    } catch {
      target.set(record.url, content);
    }
  }
}

async function runTavilyExtract(
  urls: string[],
  apiKey: string,
  signal: AbortSignal | undefined,
  depth: TavilyExtractDepth,
  raw = false,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!urls.length) return out;

  const body: { urls: string[]; extract_depth?: string } = { urls };
  if (depth === "advanced") body.extract_depth = "advanced";

  const start = Date.now();
  void logTraceEvent("tavily_extract_start", `Tavily Extract: ${urls.length} URLs`, undefined, { urlsCount: urls.length, depth });

  let response: Response;
  try {
    response = await fetch(TAVILY_EXTRACT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: combineSignal(urls.length > 1 ? 60_000 : 30_000, signal),
    });
    const latency = Date.now() - start;
    void logTraceEvent("tavily_extract_end", `Tavily Extract Complete (Status ${response.status})`, latency, { status: response.status });
  } catch (error) {
    if (!isAbortError(error)) {
      logTavily("extract", `${depth} request error`, {
        count: urls.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return out;
  }

  if (!response.ok) {
    const detail = await tavilyResponseDetail(response);
    logTavily("extract", `${depth} HTTP ${response.status}${detail ? `: ${detail}` : ""}`, {
      count: urls.length,
    });
    return out;
  }

  const payload: unknown = await response.json();
  const results =
    payload && typeof payload === "object" && "results" in payload
      ? (payload.results as unknown)
      : null;
  mergeExtractResults(out, results, raw);
  return out;
}

function normalizeExtractUrls(rawUrls: string[], cap = EXTRACT_BATCH_SIZE): string[] {
  const urls: string[] = [];
  for (const raw of rawUrls) {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      const normalized = parsed.toString();
      if (!urls.includes(normalized)) urls.push(normalized);
    } catch {
      // skip invalid
    }
    if (urls.length >= cap) break;
  }
  return urls;
}

/** ponytail: some GameFAQs pages fail basic extract; advanced is the upgrade path. */
async function extractWithAdvancedFallback(
  urls: string[],
  apiKey: string,
  signal?: AbortSignal,
  raw = false,
): Promise<Map<string, string>> {
  const out = await runTavilyExtract(urls, apiKey, signal, "basic", raw);
  let missing = urls.filter((url) => !out.has(url));
  
  if (missing.length) {
    const advanced = await runTavilyExtract(missing, apiKey, signal, "advanced", raw);
    for (const [url, content] of advanced) out.set(url, content);
    if (advanced.size) {
      logTavily("extract", "advanced extract filled basic misses", {
        recovered: advanced.size,
        missing: missing.length,
      });
    }
  }

  // Ponytail: fallback to Wayback Machine if Cloudflare blocked us
  const blockedUrls = urls.filter(url => {
    const content = out.get(url);
    return content && isBlockedGuideContent(content);
  });

  if (blockedUrls.length > 0) {
    void logTraceEvent("tavily_wayback_fallback", `GameFAQs blocked ${blockedUrls.length} URLs, falling back to Wayback Machine`, undefined, { urlsCount: blockedUrls.length });
    const waybackUrls = blockedUrls.map(url => `https://web.archive.org/web/2/${url}`);
    const waybackResults = await runTavilyExtract(waybackUrls, apiKey, signal, "basic", raw);
    
    for (let i = 0; i < blockedUrls.length; i++) {
      const originalUrl = blockedUrls[i];
      const waybackUrl = waybackUrls[i];
      const waybackContent = waybackResults.get(waybackUrl);
      if (waybackContent && !isBlockedGuideContent(waybackContent)) {
        out.set(originalUrl, waybackContent);
      }
    }
  }

  return out;
}

/**
 * Pull the full text of a guide page for RAG ingest. Given page only — does not
 * follow child links. Returns null when Tavily is unconfigured or extract fails.
 */
export async function extractGuidePage(
  rawUrl: string,
  signal?: AbortSignal,
  // Pass true for bundle discovery (needs raw markdown with TOC URLs intact);
  // leave false for RAG ingest (wants cleaned prose).
  raw = false,
): Promise<{ url: string; content: string } | null> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    logTavily("extract", "TAVILY_API_KEY is not set");
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    logTavily("extract", "invalid URL", { url: rawUrl.slice(0, 120) });
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    logTavily("extract", "URL must be http or https", { url: parsed.toString() });
    return null;
  }

  const map = await extractWithAdvancedFallback([parsed.toString()], apiKey, signal, raw);
  const content = map.get(parsed.toString());
  if (!content) {
    logTavily("extract", "no content after basic + advanced extract", {
      url: parsed.toString(),
    });
    return null;
  }

  return { url: parsed.toString(), content };
}

/**
 * Pull full text for multiple guide pages (Tavily Extract). Returns a map of
 * normalized URL → cleaned content. Skips pages that fail or are too short.
 */
export async function extractGuidePages(
  rawUrls: string[],
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey || !rawUrls.length) return new Map();

  const urls = normalizeExtractUrls(rawUrls);
  if (!urls.length) return new Map();

  return extractWithAdvancedFallback(urls, apiKey, signal);
}

/**
 * Tavily implementation. Tiered domain search with confidence gating in
 * selectSources. Throws when every Tavily call fails so the caller can fall back.
 */
async function searchTavily(
  apiKey: string,
  query: string,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  return selectSources(await tieredSearch(apiKey, query, signal));
}

/** Collect tiered Tavily results without the answer-time confidence gate. */
async function tieredSearch(
  apiKey: string,
  query: string,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const seen = new Set<string>();
  const collected: SearchResult[] = [];
  let attempts = 0;
  let failures = 0;

  for (const includeDomains of TIERS) {
    let tier: SearchResult[] = [];
    attempts += 1;
    try {
      tier = await runSearch(apiKey, query, includeDomains, signal);
    } catch (error) {
      // ponytail: per-tier failures are non-fatal; search is supporting evidence.
      failures += 1;
      if (!isAbortError(error)) {
        logTavily("search", "tier request failed", {
          tier: includeDomains.length ? includeDomains.join(", ") : "open web",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }

    for (const result of tier) {
      // Dedupe by URL and by title: GameFAQs splits one guide across several
      // URLs, so the same walkthrough can otherwise appear multiple times.
      const urlKey = `u:${result.url.replace(/\/+$/, "").toLowerCase()}`;
      const titleKey = `t:${result.title.toLowerCase()}`;
      if (seen.has(urlKey) || seen.has(titleKey)) continue;
      seen.add(urlKey);
      seen.add(titleKey);
      collected.push(result);
    }

    if (collected.length >= MIN_RESULTS) break;
  }

  // Every Tavily call failed (quota/outage) — signal the caller to try a fallback
  // instead of masking it as "no relevant results".
  if (attempts > 0 && failures === attempts) {
    logTavily("search", `all ${attempts} tier(s) failed`, {
      query: query.slice(0, 120),
    });
    throw new Error("All Tavily searches failed");
  }

  return collected;
}

const SERPER_URL = "https://google.serper.dev/search";

// Map Serper "organic" results into our SearchResult shape (snippet-only; Serper
// has no page extraction). Score is a synthetic rank so downstream trimming works.
function mapSerper(payload: unknown): SearchResult[] {
  const organic =
    payload && typeof payload === "object" && "organic" in payload
      ? (payload.organic as unknown)
      : null;
  if (!Array.isArray(organic)) return [];

  return organic.flatMap((item, index): SearchResult[] => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof (item as { link?: unknown }).link !== "string" ||
      typeof (item as { title?: unknown }).title !== "string"
    ) {
      return [];
    }
    const rawSnippet = (item as { snippet?: unknown }).snippet;
    try {
      const url = new URL((item as { link: string }).link);
      if (url.protocol !== "http:" && url.protocol !== "https:") return [];
      if (EXCLUDE_DOMAINS.some((domain) => url.hostname.endsWith(domain))) return [];
      const content = cleanSnippet(typeof rawSnippet === "string" ? rawSnippet : "").slice(
        0,
        CONTENT_CAP,
      );
      if (content.length < MIN_CONTENT) return [];
      return [
        {
          title: cleanSnippet((item as { title: string }).title) || url.hostname,
          url: url.toString(),
          content,
          score: Math.max(0.5, 1 - index * 0.05),
        },
      ];
    } catch {
      return [];
    }
  });
}

async function serperQuery(
  apiKey: string,
  q: string,
  signal?: AbortSignal,
  num = 10,
): Promise<SearchResult[]> {
  const response = await fetch(SERPER_URL, {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q, num }),
    signal: combineSignal(12_000, signal),
  });
  if (!response.ok) throw new Error(`Serper search failed with status ${response.status}`);
  return mapSerper(await response.json());
}

/**
 * Serper.dev fallback used when Tavily is unavailable. Snippet-only (no page
 * extraction). Trimmed to the top 3.
 */
async function searchSerper(
  apiKey: string,
  query: string,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  return (await serperQuery(apiKey, query, signal)).slice(0, 3);
}

/**
 * Find supporting web sources for a query. Uses Tavily first; if Tavily is
 * unconfigured or every call fails (quota/outage), falls back to Serper.dev when
 * `SERPER_API_KEY` is set. Returns [] when nothing relevant; throws only when no
 * provider is configured or the sole provider fails with no backup.
 */
export async function searchGuides(
  query: string,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const tavilyKey = process.env.TAVILY_API_KEY;
  const serperKey = process.env.SERPER_API_KEY;
  if (!tavilyKey && !serperKey) {
    throw new Error("No search provider configured (TAVILY_API_KEY or SERPER_API_KEY)");
  }

  if (tavilyKey) {
    try {
      return await searchTavily(tavilyKey, query, signal);
    } catch (error) {
      if (!serperKey) throw error;
      console.error(
        "Tavily search unavailable; falling back to Serper:",
        error instanceof Error ? error.message : error,
      );
    }
  }
  return searchSerper(serperKey as string, query, signal);
}

const DISCOVER_MAX = 8;

export { buildGuideDiscoveryQuery } from "@/lib/guide-search.js";

/** Browse guide links for the preferred-guide picker (no confidence gate). */
export async function discoverGuideLinks(
  game: string,
  platform: string,
  query = "",
): Promise<SearchResult[]> {
  const searchQuery = buildGuideDiscoveryQuery(game, platform, query);
  if (!searchQuery) return [];

  const tavilyKey = process.env.TAVILY_API_KEY;
  const serperKey = process.env.SERPER_API_KEY;
  if (!tavilyKey && !serperKey) {
    throw new Error("No search provider configured (TAVILY_API_KEY or SERPER_API_KEY)");
  }

  if (tavilyKey) {
    try {
      return (await tieredSearch(tavilyKey, searchQuery))
        .sort((a, b) => b.score - a.score)
        .slice(0, DISCOVER_MAX);
    } catch (error) {
      if (!serperKey) throw error;
      console.error(
        "Tavily search unavailable; falling back to Serper:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  return (await searchSerper(serperKey as string, searchQuery)).slice(0, DISCOVER_MAX);
}

/**
 * Site-scoped URL discovery for multi-page guide bundles (no confidence gate).
 */
export async function searchDiscoveryUrls(
  query: string,
  signal?: AbortSignal,
  options: { maxResults?: number; domains?: string[] } = {},
): Promise<SearchResult[]> {
  const maxResults = options.maxResults ?? 25;
  const domains = options.domains ?? [];
  const tavilyKey = process.env.TAVILY_API_KEY;
  const serperKey = process.env.SERPER_API_KEY;

  if (tavilyKey) {
    try {
      const results = await runSearch(tavilyKey, query, domains, signal, maxResults);
      if (results.length) return results;
    } catch (error) {
      if (!serperKey) throw error;
      console.error(
        "Tavily discovery search failed; falling back to Serper:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  if (serperKey) {
    try {
      return (await serperQuery(serperKey, query, signal, maxResults)).slice(0, maxResults);
    } catch (error) {
      console.error(
        "Serper discovery search failed:",
        error instanceof Error ? error.message : error,
      );
      return [];
    }
  }

  return [];
}
