import { guideUrlDedupeKey } from "./guide-urls.js";

const STORAGE_KEY = "gg:bundle-prefs";
export const BUNDLE_PREFS_META_KEY = "bundle_prefs";
const MAX_BUNDLE_PREF_KEYS = 5;
const MAX_SLUGS_PER_BUNDLE = 50;
const MAX_SLUG_LEN = 80;

/** @typedef {{ selectedSlugs?: string[]; skippedSlugs: string[] }} BundlePrefs */

/** @type {import("@supabase/supabase-js").SupabaseClient | null} */
let syncClient = null;

/** @param {import("@supabase/supabase-js").SupabaseClient | null} client */
export function registerBundlePrefsSync(client) {
  syncClient = client;
}

/** @returns {Record<string, BundlePrefs>} */
function loadAll() {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** @param {Record<string, BundlePrefs>} all */
function saveAll(all) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // quota / private mode
  }
}

/** @returns {Record<string, BundlePrefs>} */
export function loadAllBundlePrefs() {
  return loadAll();
}

/** @param {unknown} value @returns {string[]} */
function coerceSlugList(value) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((slug) => typeof slug === "string" && slug.trim())
        .map((slug) => slug.toLowerCase().slice(0, MAX_SLUG_LEN)),
    ),
  ].slice(0, MAX_SLUGS_PER_BUNDLE);
}

/** @param {unknown} value @returns {BundlePrefs} */
export function coerceBundlePrefsRow(value) {
  if (!value || typeof value !== "object") return { skippedSlugs: [] };
  const record = /** @type {Record<string, unknown>} */ (value);
  const skippedSlugs = coerceSlugList(record.skippedSlugs ?? record.skipSlugs);
  const selectedSlugs = coerceSlugList(record.selectedSlugs ?? record.includeSlugs);
  return {
    skippedSlugs,
    ...(selectedSlugs.length ? { selectedSlugs } : {}),
  };
}

/** @param {unknown} metadata @returns {Record<string, BundlePrefs>} */
export function bundlePrefsAllFromUserMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return {};
  const raw = /** @type {Record<string, unknown>} */ (metadata)[BUNDLE_PREFS_META_KEY];
  if (!raw || typeof raw !== "object") return {};
  const out = /** @type {Record<string, BundlePrefs>} */ ({});
  for (const [key, row] of Object.entries(raw).slice(0, MAX_BUNDLE_PREF_KEYS)) {
    if (typeof key !== "string" || !key.startsWith("http")) continue;
    out[key.slice(0, 300)] = coerceBundlePrefsRow(row);
  }
  return out;
}

/**
 * Merge local + remote bundle prefs (union skips; remote wins selected when set).
 * @param {Record<string, BundlePrefs>} local
 * @param {Record<string, BundlePrefs>} remote
 */
export function mergeBundlePrefsAll(local, remote) {
  const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  const out = /** @type {Record<string, BundlePrefs>} */ ({});
  for (const key of keys) {
    const l = local[key];
    const r = remote[key];
    if (!l && !r) continue;
    const skippedSlugs = [
      ...new Set([...(l?.skippedSlugs ?? []), ...(r?.skippedSlugs ?? [])]),
    ];
    const selectedSlugs = r?.selectedSlugs?.length
      ? r.selectedSlugs
      : l?.selectedSlugs;
    out[key] = {
      skippedSlugs,
      ...(selectedSlugs?.length ? { selectedSlugs } : {}),
    };
  }
  return trimBundlePrefsForMetadata(out);
}

/** @param {Record<string, BundlePrefs>} all */
export function trimBundlePrefsForMetadata(all) {
  const out = /** @type {Record<string, BundlePrefs>} */ ({});
  for (const [key, row] of Object.entries(all)
    .filter(([key]) => typeof key === "string" && key.startsWith("http"))
    .slice(0, MAX_BUNDLE_PREF_KEYS)) {
    out[key.slice(0, 300)] = coerceBundlePrefsRow(row);
  }
  return out;
}

/**
 * Pull cloud prefs into localStorage and push merged state back when needed.
 * @param {unknown} metadata
 * @param {import("@supabase/supabase-js").SupabaseClient | null | undefined} supabase
 */
export function hydrateBundlePrefsFromUser(metadata, supabase) {
  const remote = bundlePrefsAllFromUserMetadata(metadata);
  const local = loadAll();
  const merged = mergeBundlePrefsAll(local, remote);
  if (JSON.stringify(merged) !== JSON.stringify(local)) {
    saveAll(merged);
  }
  const remoteTrimmed = trimBundlePrefsForMetadata(remote);
  if (
    supabase &&
    Object.keys(merged).length &&
    JSON.stringify(trimBundlePrefsForMetadata(merged)) !== JSON.stringify(remoteTrimmed)
  ) {
    void syncBundlePrefsToUser(supabase, merged);
  }
  return merged;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient | null | undefined} supabase
 * @param {Record<string, BundlePrefs>} all
 */
export async function syncBundlePrefsToUser(supabase, all) {
  if (!supabase) return;
  try {
    const bundle_prefs = trimBundlePrefsForMetadata(all);
    await supabase.auth.updateUser({
      data: { [BUNDLE_PREFS_META_KEY]: Object.keys(bundle_prefs).length ? bundle_prefs : null },
    });
  } catch (error) {
    console.error("Failed to sync bundle prefs:", error);
  }
}

function syncAfterSave() {
  if (!syncClient) return;
  void syncBundlePrefsToUser(syncClient, loadAll());
}

/** @param {string} url */
function prefsKey(url) {
  return guideUrlDedupeKey(url) || url;
}

/** @param {string} url @returns {BundlePrefs} */
export function getBundlePrefs(url) {
  const row = loadAll()[prefsKey(url)];
  const skippedSlugs = Array.isArray(row?.skippedSlugs)
    ? row.skippedSlugs.filter((slug) => typeof slug === "string" && slug.trim())
    : [];
  const selectedSlugs = Array.isArray(row?.selectedSlugs)
    ? row.selectedSlugs.filter((slug) => typeof slug === "string" && slug.trim())
    : undefined;
  return {
    skippedSlugs,
    ...(selectedSlugs?.length ? { selectedSlugs } : {}),
  };
}

/** @param {string} url @param {BundlePrefs} prefs */
export function setBundlePrefs(url, prefs) {
  const key = prefsKey(url);
  const all = loadAll();
  const skippedSlugs = Array.isArray(prefs.skippedSlugs)
    ? [...new Set(prefs.skippedSlugs.map((slug) => slug.toLowerCase()))]
    : [];
  const selectedSlugs = Array.isArray(prefs.selectedSlugs)
    ? [...new Set(prefs.selectedSlugs.map((slug) => slug.toLowerCase()))]
    : undefined;
  all[key] = {
    skippedSlugs,
    ...(selectedSlugs?.length ? { selectedSlugs } : {}),
  };
  saveAll(all);
  syncAfterSave();
}

/** @param {string} url @param {string} slug */
export function skipBundlePage(url, slug) {
  const prefs = getBundlePrefs(url);
  const normalized = slug.toLowerCase();
  if (prefs.skippedSlugs.includes(normalized)) return prefs;
  const next = {
    ...prefs,
    skippedSlugs: [...prefs.skippedSlugs, normalized],
  };
  setBundlePrefs(url, next);
  return next;
}

/**
 * Skip every slug in `missingSlugs` (bulk "ignore remaining").
 * @param {string} url
 * @param {string[]} missingSlugs
 */
export function skipAllMissingBundlePages(url, missingSlugs) {
  const prefs = getBundlePrefs(url);
  const skip = new Set(prefs.skippedSlugs.map((slug) => slug.toLowerCase()));
  for (const slug of missingSlugs) {
    if (typeof slug === "string" && slug.trim()) skip.add(slug.toLowerCase());
  }
  const next = { ...prefs, skippedSlugs: [...skip] };
  setBundlePrefs(url, next);
  return next;
}

/** @param {string} url @param {string} slug */
export function unskipBundlePage(url, slug) {
  const prefs = getBundlePrefs(url);
  const normalized = slug.toLowerCase();
  const next = {
    ...prefs,
    skippedSlugs: prefs.skippedSlugs.filter((entry) => entry !== normalized),
  };
  setBundlePrefs(url, next);
  return next;
}

/**
 * Limit panel / status lists to the user's add-time selection when set.
 * @template {{ slug: string }} T
 * @param {T[]} pages
 * @param {string[] | undefined} selectedSlugs
 * @returns {T[]}
 */
export function filterBundlePanelPages(pages, selectedSlugs) {
  if (!selectedSlugs?.length) return pages;
  const allowed = new Set(selectedSlugs.map((slug) => slug.toLowerCase()));
  return pages.filter((page) => allowed.has(page.slug.toLowerCase()));
}

/**
 * Slugs we intend to index (selected minus skipped).
 * @param {{ slug: string }[]} discovered
 * @param {BundlePrefs} prefs
 */
export function targetBundleSlugs(discovered, prefs) {
  const discoveredSlugs = discovered.map((page) => page.slug.toLowerCase());
  const skip = new Set(prefs.skippedSlugs.map((slug) => slug.toLowerCase()));
  let slugs = prefs.selectedSlugs?.length
    ? prefs.selectedSlugs.map((slug) => slug.toLowerCase())
    : discoveredSlugs;
  if (prefs.selectedSlugs?.length) {
    const allowed = new Set(discoveredSlugs);
    slugs = slugs.filter((slug) => allowed.has(slug));
  }
  return slugs.filter((slug) => !skip.has(slug));
}

/**
 * True when at least one target slug is not indexed yet.
 * @param {{ slug: string }[]} discovered
 * @param {string[]} indexedSlugs
 * @param {BundlePrefs} prefs
 */
export function bundleHasPendingPages(discovered, indexedSlugs, prefs) {
  const indexed = new Set(indexedSlugs.map((slug) => slug.toLowerCase()));
  const targets = targetBundleSlugs(discovered, prefs);
  return targets.some((slug) => !indexed.has(slug));
}

/**
 * Shape for guide-ingest / solve API bodies.
 * @param {string} url
 */
export function bundlePrefsForApi(url) {
  const prefs = getBundlePrefs(url);
  return {
    skipSlugs: prefs.skippedSlugs,
    ...(prefs.selectedSlugs?.length ? { includeSlugs: prefs.selectedSlugs } : {}),
  };
}

/**
 * Coerce bundle prefs from an API body map.
 * @param {unknown} value
 * @returns {Record<string, BundlePrefs>}
 */
export function coerceBundlePrefsFromBody(value) {
  if (!value || typeof value !== "object") return {};
  const out = /** @type {Record<string, BundlePrefs>} */ ({});
  for (const [url, row] of Object.entries(value)) {
    if (!url || typeof url !== "string" || !row || typeof row !== "object") continue;
    const record = /** @type {Record<string, unknown>} */ (row);
    const skippedSlugs = Array.isArray(record.skipSlugs)
      ? record.skipSlugs
          .filter((slug) => typeof slug === "string" && slug.trim())
          .map((slug) => slug.toLowerCase().slice(0, 120))
      : [];
    const includeSlugs = Array.isArray(record.includeSlugs)
      ? record.includeSlugs
          .filter((slug) => typeof slug === "string" && slug.trim())
          .map((slug) => slug.toLowerCase().slice(0, 120))
      : undefined;
    out[url] = {
      skippedSlugs,
      ...(includeSlugs?.length ? { selectedSlugs: includeSlugs } : {}),
    };
  }
  return out;
}
