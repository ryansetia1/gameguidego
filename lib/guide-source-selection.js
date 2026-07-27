import {
  guideUrlDedupeKey,
  guideUrlHostLabel,
  normalizeGuideUrlList,
  normalizePreferredGuideUrl,
} from "./guide-urls.js";

/** @typedef {string[] | null} GuideSourceSelection null = Auto (all preferred guides) */

/**
 * True when two URL lists cover the same preferred guides (dedupe keys).
 * @param {string[]} a
 * @param {string[]} b
 */
function sameGuideUrlSet(a, b) {
  const keysA = new Set(a.map((url) => guideUrlDedupeKey(url)));
  const keysB = new Set(b.map((url) => guideUrlDedupeKey(url)));
  if (keysA.size !== keysB.size) return false;
  for (const key of keysA) {
    if (!keysB.has(key)) return false;
  }
  return true;
}

/**
 * Resolve a preferred URL from the room list by dedupe key.
 * @param {string} raw
 * @param {string[]} preferredUrls
 * @returns {string | null}
 */
function matchPreferredUrl(raw, preferredUrls) {
  const cleaned = normalizePreferredGuideUrl(raw);
  if (!cleaned) return null;
  const key = guideUrlDedupeKey(cleaned);
  return preferredUrls.find((url) => guideUrlDedupeKey(url) === key) ?? null;
}

/**
 * Trust-boundary subset for POST /api/solve.
 * Returns null for Auto; otherwise a non-empty subset of preferredUrls.
 * @param {Record<string, unknown>} record
 * @param {string[]} preferredUrls
 * @returns {string[] | null}
 */
export function coerceRagGuideUrls(record, preferredUrls) {
  const preferred = normalizeGuideUrlList(preferredUrls);
  if (!preferred.length) return null;

  const raw = record.ragGuideUrls;
  if (!Array.isArray(raw) || !raw.length) return null;

  const subset = [];
  const seen = new Set();
  for (const item of raw) {
    const matched = matchPreferredUrl(item, preferred);
    if (!matched) continue;
    const key = guideUrlDedupeKey(matched);
    if (seen.has(key)) continue;
    seen.add(key);
    subset.push(matched);
  }

  if (!subset.length || sameGuideUrlSet(subset, preferred)) return null;
  return subset;
}

/**
 * Effective RAG pool for this turn.
 * @param {string[]} preferredUrls
 * @param {string[] | null | undefined} ragGuideUrls subset from client; null/undefined = Auto
 * @returns {string[]}
 */
export function effectiveRagGuideUrls(preferredUrls, ragGuideUrls) {
  const preferred = normalizeGuideUrlList(preferredUrls);
  if (!ragGuideUrls?.length) return preferred;
  const subset = normalizeGuideUrlList(ragGuideUrls).filter((url) =>
    preferred.some((p) => guideUrlDedupeKey(p) === guideUrlDedupeKey(url)),
  );
  return subset.length ? subset : preferred;
}

/**
 * Coerce persisted message field (no preferred-room filter at load time).
 * @param {unknown} value
 * @returns {string[] | null}
 */
export function coerceStoredRagGuideUrls(value) {
  if (!Array.isArray(value) || !value.length) return null;
  const urls = normalizeGuideUrlList(value);
  return urls.length ? urls : null;
}

/**
 * @param {string[] | null} selection
 * @param {string[]} preferredUrls
 * @param {Record<string, { title?: string }>} guideMeta
 * @param {Record<string, string | undefined>} guideIndexState
 * @returns {string}
 */
export function guideSourceStripLabel(
  selection,
  preferredUrls,
  guideMeta,
  guideIndexState,
) {
  void preferredUrls;
  void guideIndexState;
  if (!selection?.length) return "Auto";
  if (selection.length === 1) {
    const url = selection[0];
    const title = guideMeta[url]?.title?.trim();
    const label = title || guideUrlHostLabel(url) || "1 guide";
    return label.length > 36 ? `${label.slice(0, 33)}…` : label;
  }
  return `${selection.length} selected`;
}

/**
 * @param {string} url
 * @param {Record<string, string | undefined>} guideIndexState
 * @returns {boolean}
 */
export function isGuideUrlSelectable(url, guideIndexState) {
  return guideIndexState[url] === "indexed";
}

/**
 * Block send when a manual subset has no indexed guides.
 * @param {string[] | null} selection
 * @param {string[]} preferredUrls
 * @param {Record<string, string | undefined>} guideIndexState
 * @param {boolean} skipPreferredGuide
 * @returns {string | null}
 */
export function guideSourceSendBlockReason(
  selection,
  preferredUrls,
  guideIndexState,
  skipPreferredGuide,
) {
  if (skipPreferredGuide || preferredUrls.length <= 1) return null;
  const targets = selection?.length ? selection : null;
  if (!targets?.length) return null;
  const indexed = targets.filter((url) => isGuideUrlSelectable(url, guideIndexState));
  if (!indexed.length) {
    return "Wait for your guide to finish indexing, or choose Auto.";
  }
  return null;
}

/**
 * Guides that block the composer while indexing (subset-aware).
 * @param {string[] | null} selection
 * @param {string[]} preferredUrls
 * @returns {string[]}
 */
export function guideUrlsBlockingComposer(selection, preferredUrls) {
  if (!preferredUrls.length) return [];
  return selection?.length ? selection : preferredUrls;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const preferred = [
    "https://gamefaqs.gamespot.com/a",
    "https://gamefaqs.gamespot.com/b",
  ];
  const subset = coerceRagGuideUrls({ ragGuideUrls: [preferred[0]] }, preferred);
  console.assert(subset?.length === 1 && subset[0] === preferred[0]);
  console.assert(coerceRagGuideUrls({ ragGuideUrls: preferred }, preferred) === null);
  console.assert(
    sameGuideUrlSet(effectiveRagGuideUrls(preferred, null), preferred),
  );
  console.assert(
    guideSourceSendBlockReason([preferred[0]], preferred, { [preferred[0]]: "checking" }, false) !== null,
  );
  console.log("guide-source-selection ok");
}
