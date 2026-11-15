import { getServerClient } from "@/lib/supabase-server";

import {
  HLTB_TTL_MS,
  buildHltbData,
  hltbCacheKey,
  normalizeTitle,
  parseHltbSearch,
  pickBestMatch,
} from "./hltb.js";

// Server-only read-through cache over HowLongToBeat playtime. Mirrors
// lib/search-cache.js: read row -> if fresh return it, else search upstream +
// upsert. Fail-open to a direct search when Supabase is unconfigured.
// `hltb_cache.data` is nullable: a fresh null row means "searched HLTB, no match".
// Cache key is the normalized game title (any platform).

const HLTB = "https://howlongtobeat.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// ponytail: HLTB has no public API. Its internal search endpoint rotates its
// path segment to break scrapers (... bleed -> search/site) and gates it behind a
// per-visit token fetched from `/api/<seg>/init`. `bleed` 404s now; `search/site`
// (same request body, init no longer returns the hp pair but it is still handled)
// was verified working 2026-11, same fix as steamAntiFomo. Ceiling:
// when HLTB rotates again, init/search 404 and the playtime line simply won't
// render (graceful). Upgrade path: update SEARCH_SEG (grep the site's `_next`
// JS chunk for `/api/<seg>/init`) or add runtime segment discovery.
const SEARCH_SEG = "search/site";

const TOKEN_TTL_MS = 5 * 60 * 1000;

/** @typedef {{ token: string, hpKey: string | null, hpVal: string | null, at: number }} HltbToken */

/**
 * @param {number} fetchedAt
 * @param {number} ttlMs
 * @param {number} [now]
 */
function isFresh(fetchedAt, ttlMs, now = Date.now()) {
  return fetchedAt > 0 && now - fetchedAt < ttlMs;
}

const baseHeaders = {
  "User-Agent": UA,
  Referer: `${HLTB}/`,
  Origin: HLTB,
};

/** @type {{ token: string, hpKey: string | null, hpVal: string | null, at: number } | null} */
let tokenCache = null;

async function fetchToken() {
  const res = await fetch(`${HLTB}/api/${SEARCH_SEG}/init?t=${Date.now()}`, {
    headers: baseHeaders,
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HLTB init failed (${res.status})`);
  const json = await res.json();
  if (!json?.token) throw new Error("HLTB init missing token");
  return {
    token: json.token,
    hpKey: typeof json.hpKey === "string" ? json.hpKey : null,
    hpVal: typeof json.hpVal === "string" ? json.hpVal : null,
    at: Date.now(),
  };
}

async function getToken(force = false) {
  if (!force && tokenCache && Date.now() - tokenCache.at < TOKEN_TTL_MS) {
    return tokenCache;
  }
  tokenCache = await fetchToken();
  return tokenCache;
}

/**
 * @param {string[]} terms
 * @param {HltbToken} tok
 */
function searchBody(terms, tok) {
  /** @type {Record<string, unknown>} */
  const body = {
    searchType: "games",
    searchTerms: terms,
    searchPage: 1,
    size: 20,
    searchOptions: {
      games: {
        userId: 0,
        platform: "",
        sortCategory: "popular",
        rangeCategory: "main",
        rangeTime: { min: 0, max: 0 },
        gameplay: { perspective: "", flow: "", genre: "", difficulty: "" },
        rangeYear: { min: "", max: "" },
        modifier: "",
      },
      users: { sortCategory: "postcount" },
      lists: { sortCategory: "follows" },
      filter: "",
      sort: 0,
      randomizer: 0,
    },
    useCache: true,
  };
  if (tok.hpKey) body[tok.hpKey] = tok.hpVal;
  return body;
}

/**
 * @param {string[]} terms
 * @param {HltbToken} tok
 */
async function postSearch(terms, tok) {
  /** @type {Record<string, string>} */
  const headers = {
    ...baseHeaders,
    "Content-Type": "application/json",
    "x-auth-token": tok.token,
  };
  if (tok.hpKey) {
    headers["x-hp-key"] = tok.hpKey;
    headers["x-hp-val"] = String(tok.hpVal ?? "");
  }
  return fetch(`${HLTB}/api/${SEARCH_SEG}`, {
    method: "POST",
    headers,
    body: JSON.stringify(searchBody(terms, tok)),
    cache: "no-store",
  });
}

/**
 * Search HLTB for `title` and return the best match reduced to HltbData.
 * @param {string} title
 * @param {string} [appId]
 */
async function searchHltb(title, appId = "") {
  const terms = normalizeTitle(title).split(" ").filter(Boolean);
  if (terms.length === 0) return null;

  let tok = await getToken();
  let res = await postSearch(terms, tok);
  if (res.status === 403) {
    tok = await getToken(true);
    res = await postSearch(terms, tok);
  }
  if (!res.ok) throw new Error(`HLTB search failed (${res.status})`);
  const games = parseHltbSearch(await res.json());
  const match = pickBestMatch(games, title, appId);
  return match ? buildHltbData(match) : null;
}

/**
 * Playtime for one game, cache-first. Keyed by normalized title; optional
 * `appId` improves Steam matching on a cache miss only.
 *
 * @param {string} title
 * @param {string} [appId]
 */
export async function fetchHltb(title, appId = "") {
  const cacheKey = hltbCacheKey(title);
  if (!cacheKey) {
    return { data: null, fetchedAt: new Date().toISOString(), pending: false };
  }

  const supabase = getServerClient();
  if (!supabase) {
    const data = await searchHltb(title, appId);
    return { data, fetchedAt: new Date().toISOString(), pending: false };
  }

  const { data: cached } = await supabase
    .from("hltb_cache")
    .select("data, fetched_at")
    .eq("cache_key", cacheKey)
    .maybeSingle();
  const cachedAt = cached ? new Date(cached.fetched_at).getTime() : 0;
  const cachedData = cached?.data ?? null;
  if (cached && cachedAt > 0 && isFresh(cachedAt, HLTB_TTL_MS, Date.now())) {
    return { data: cachedData, fetchedAt: String(cached.fetched_at), pending: false };
  }

  let data;
  try {
    data = await searchHltb(title, appId);
  } catch (err) {
    if (cached && cachedAt > 0) {
      return { data: cachedData, fetchedAt: String(cached.fetched_at), pending: false };
    }
    throw err;
  }
  const fetchedAt = new Date().toISOString();
  try {
    await supabase
      .from("hltb_cache")
      .upsert({ cache_key: cacheKey, data, fetched_at: fetchedAt });
  } catch {
    // Best-effort: the answer still returns even when the cache write fails.
  }
  return { data, fetchedAt, pending: false };
}
