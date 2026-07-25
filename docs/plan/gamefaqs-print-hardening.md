# GameFAQs print-ingest hardening (post-simplification follow-ups)

**Status:** Implemented (2026-07-26) — items 1, 2, 4 done; item 3 kept as-is (see notes).
Follow-ups to the "treat every GameFAQs guide as one
`?print=1` page" refactor (commits `0ec2d49`…`00721e1`). That refactor deleted the whole
bundle/discovery/dedup apparatus (`gamefaqs-discover`, `guide-bundle-cache`,
`bundle-prefs`, ~3000 net lines) and is the right architecture. These are small,
independent hardening items — none is a blocker.

Do them in any order; each is self-contained. Skip any that stops mattering.

---

## 1. The 20k quality gate can false-reject a genuinely short guide — DONE

**Done:** `gamefaqsExtractQuality` now rejects TOC-only first, then accepts any
non-TOC body ≥ `MIN_GUIDE_BODY_CHARS` (400); `too_short` reserved for near-empty.
The re-ingest purge in `guide-ingest.ts` runs the same quality gate on the
concatenated stored chunk text instead of a raw `< 20k` char count, so a small
real guide is no longer purged + re-embedded every turn (legacy TOC-only rows
still self-heal since they fail the gate). Self-check cases updated.

**Where:** `gamefaqsExtractQuality` + `MIN_GAMEFAQS_GUIDE_CHARS = 20_000` in
`lib/gamefaqs-bundle.js`; consumed in `lib/guide-ingest.ts#ingestGuidePage`.

**Problem:** the gate rejects an extract when it's TOC-only OR `< 20k` chars. That's
correct for catching a partial/intro-only extract, but a *legitimately small* GameFAQs
guide (a short FAQ, a mini boss guide) that is genuinely under 20k will be judged
`insufficient` and **never index** — and the char-count re-ingest path uses the same
threshold, so it never self-heals into being accepted.

**Fix (lazy):** keep the TOC-only rejection (that's the real signal), but make the
length check *soft*: if the extract is **not TOC-only** and is **stable across two
attempts** (same content, not growing), accept it even under 20k. Concretely, treat
"not TOC-only + non-trivial (e.g. ≥ MIN_GUIDE_CHARS = 400)" as indexable, and reserve
`too_short` for near-empty (< ~400). Rationale: TOC-only is the thing we actually need
to reject; raw length is a weak proxy that punishes small real guides.

**Ceiling:** without a second-attempt comparison we can't tell "small real guide" from
"transient thin extract" on the first try — accept the small guide and let the
char-re-ingest replace it if a later fuller extract arrives. `ponytail:` note it.

**Check:** `gamefaqsExtractQuality` is a pure branch → add self-check cases (TOC-only →
insufficient; 300-char body → too_short; 5k non-TOC body → **acceptable**; 50k → ok).

---

## 2. Final dead-code sweep after the refactor — DONE (nothing to delete)

**Done:** grepped every export of `gamefaqs-bundle.js`, `guide-card-ui.js`,
`guide-hints.js`, and `use-guide-bundle.tsx` for external references — all are
still used, no orphans. `guide_bundle_cache` is still needed (display-title cache
read in `ingestGuidePage`). `tsc --noEmit` clean.

**Status:** mostly already done — the refactor deleted `parseGamefaqsTocLinks`,
`parseGamefaqsTocFromHtml`, `countDuplicateSlugs`, `recordBundlePageFailures`,
`settledBundleSlugs`, `realFailuresOnly`, `coercePageStatus` (all confirmed gone).

**Remaining:** one verification pass for orphaned exports/consts left behind in the
trimmed files (`lib/gamefaqs-bundle.js`, `lib/guide-card-ui.js`, `lib/guide-hints.js`,
`app/chat/use-guide-bundle.tsx`). Grep each `export` for external references; delete the
ones with zero. Also confirm `db/` no longer needs `guide_bundle_cache` beyond the
title-cache reuse (`ingestGuidePage` still reads it for the display title).

**Check:** `npm run check` + `tsc` after each deletion (compiler catches most orphans).

---

## 3. `dedupeByChunkText` in RAG is now belt-and-suspenders — KEPT

**Decision:** kept as-is (the plan's "legacy dupes may linger" branch). Can't
verify the live DB is clean from here, and it's cheap + correct, so removing the
over-fetch + dedup would trade safety for nothing. The existing comment already
marks it transitional. Revisit + revert to `p_limit: RETRIEVE_K` once
`db/reset-gamefaqs-guides.sql` has been run in prod and dupes are confirmed gone.

**Where:** `lib/guide-rag.ts` (`dedupeByChunkText`, `RETRIEVE_FETCH = RETRIEVE_K * 4`).

**Problem:** it over-fetches 4× and collapses byte-identical chunk text to restore
diversity — needed only when the same guide was stored under many URLs (the old 25×
duplication). With one canonical storage URL there are no duplicate chunks anymore, so
this only ever helps *legacy* rows still duplicated in the DB.

**Fix:** two options, pick after checking the DB —
- **If legacy duplicated rows are cleaned** (e.g. via `db/reset-gamefaqs-guides.sql`):
  revert to `p_limit: RETRIEVE_K` and drop `dedupeByChunkText` + `RETRIEVE_FETCH`. Fewer
  moving parts, one fewer over-fetch.
- **If legacy dupes may linger:** keep it (cheap, correct) and just leave a comment that
  it's transitional.

**Ceiling:** dropping it means a future re-introduction of duplicate storage would resurface
the diversity bug — but the canonical-URL design makes that structurally impossible, so
removal is safe once the DB is clean.

---

## 4. Transient empty/thin `?print=1` on the first question after add — DONE (option A)

**Done:** implemented **option A** (not the recommended B). In
`extractWithAdvancedFallback` the `?print=1` extract now retries once when the
first pass comes back empty/insufficient, before falling through to the paginated
page. Chose A over B (warm-on-add) because it's a contained server-side diff with
no React-hooks/deps risk (repo's strict Rules-of-Hooks lint rule), and it only
adds latency on the rare transient-miss turn it's fixing — the common path is
untouched. Wayback + the item-1 quality re-ingest remain the self-heal floor.
Also factored the duplicated single-result fallback into a `pickExtracted` helper.

**Where:** `lib/tavily.ts` (extract order: `?print=1` → normal → advanced → Wayback) +
`lib/guide-ingest.ts#ingestGuidePage` (lazy ingest on the first solve turn).

**Problem:** GameFAQs/Tavily occasionally returns empty or thin `?print=1` (observed
live twice on faqs/80674 — 0 chars once, full 443k another). Ingest is lazy (runs on the
first question), so if that first extract is thin/blocked, the turn answers **without**
the guide, then self-heals on the next question (re-ingest sees no/short chunks and
retries). Acceptable, but the first answer is degraded.

**Fix (optional, in order of effort):**
- **A (cheap):** add one in-request retry of the `?print=1` extract (short backoff)
  before falling through — transient empties often succeed on immediate retry.
- **B:** warm the ingest at *add* time, not first-question — kick a background
  `ensureGuideIngested` when the URL is committed (`commitAddUrl` → fire-and-forget POST),
  so by the time the user asks, chunks usually exist. The status chip already shows
  progress.
- **C (most robust):** on the first solve turn for a not-yet-indexed preferred guide,
  briefly block on ingest (bounded timeout) instead of racing web fallback, so the first
  answer uses the guide when the extract succeeds quickly.

**Ceiling:** none fully removes the dependency on Tavily's flakiness; they shrink the
window. Wayback + char-re-ingest already prevent permanent failure. `ponytail:` B is the
best effort/return — warm-on-add, keep lazy as the fallback.

---

## Cross-links

- Simplified ingest: `lib/guide-ingest.ts` (`ingestGuidePage`, `ensureGuideIngested`,
  `gamefaqsStorageUrl`), `lib/gamefaqs-bundle.js` (`gamefaqsExtractQuality`,
  `gamefaqsPrintExtractUrl`, `canonicalGamefaqsBundleUrl`)
- Extract + fallbacks: `lib/tavily.ts`, `lib/wayback.js`
- RAG: `lib/guide-rag.ts`
- Reset helper: `db/reset-gamefaqs-guides.sql`
