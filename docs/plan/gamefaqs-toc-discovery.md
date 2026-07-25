# GameFAQs bundle: TOC-based discovery + content dedup

**Status:** Shipped (2026-07-26). All 4 phases built. Gates green (`check`, `tsc`,
`build`). Diagnosis grounded in live traces (Suikoden `gamefaqs:79809`, `gamefaqs:80674`).

### What shipped
- **Phase 2+4 (dedup / print-once):** content-hash dedup per ingest run in
  `ingestGamefaqsBundle` — the first unique page is stored, later pages with identical
  content are marked `duplicate` (settled, counted as covered, hidden from "couldn't
  add"). Kills the 25× duplication and gives print-once for free.
- **Retrieval dedup:** `lib/guide-rag.ts` over-fetches `RETRIEVE_K*4` then collapses
  identical chunk text to K distinct — fixes diversity for legacy 25×-data too.
- **Phase 1 (TOC titles):** `slugFromGamefaqsTitle` + `parseGamefaqsTocByTitles`
  (`lib/gamefaqs-bundle.js`), wired into `discoverGamefaqsBundleViaExtract` as a
  fallback when the href-regex TOC finds ≤1. Best-effort; candidates that don't resolve
  self-clean via failed-page tracking.
- **Phase 3 (root URL):** `previewGuideUrl` runs discovery (`?refresh=1`) for FAQ root
  URLs too, not just section URLs.

### Deliberate ponytail cuts (self-healing)
- Ingest dedup hashes raw extracted content; if a per-section nav marker makes raw
  content differ, retrieval dedup still collapses the identical chunks. If the first
  page's store fails mid-batch, its duplicate is marked settled but re-stored on the
  next turn (the primary is retried).
- Phase 1 title parser can over-capture the LAST "Part N:" title (no following marker);
  that one candidate simply fails ingest and is recorded.
- Phase 3 makes every GameFAQs add run a full Tavily discovery; the route's 30s
  per-URL cooldown caps repeat cost.
- No `content_hash` DB column / unique index yet (in-app dedup covers it); add later
  only if cross-run duplicate storage shows up in practice.

## Why this exists

The GameFAQs multi-page bundle path is unreliable. Live testing hit **three distinct
failures on three guides**, all rooted in how discovery works:

| Guide | Observed | Root cause |
|-------|----------|------------|
| `79809` (25 parts) | Discovery found 25 pages, but **2290 chunks = 101 unique × 25** (whole guide stored 25×) | `?print=1` returned the *entire* guide for every section URL → duplication |
| `80674` root URL | "Not detected as bundle" | Root URL has no `sectionSlug` → add-time treats it single-page (no discovery) |
| `80674` section URL | Full Tavily refresh returns `{bundle:false, singlePage:true}` → only intro (3 chunks) indexed | `parseGamefaqsTocFromHtml` found **0 TOC links**, so `isLikelySinglePageGamefaqsGuide` misfired |

## The precise failure (the important one)

`parseGamefaqsTocFromHtml` (`lib/gamefaqs-bundle.js`) finds sibling pages by regex over
the extracted content:

```js
new RegExp(`\\/faqs\\/${faqId}\\/([a-z0-9][a-z0-9-]*)`, "gi")
```

It needs the **literal URL path** `/faqs/80674/<slug>` to appear in Tavily's extracted
text. For `80674`, Tavily flattened the sidebar TOC to **plain title text**
("Table of Contents 1. Introduction 2. Journeys Start Part 1: The First Steps …") with
**no hrefs** → the regex matched nothing → `toc.length === 0` →
`isLikelySinglePageGamefaqsGuide` returned `true` → `bundle:false` cached as
`{singlePage:true}`. Discovery gave up.

So the section **titles are present** in the extract; the **URLs are not**. Discovery
relies on the URLs. That's the gap.

GameFAQs blocks direct HTML fetch (Cloudflare 403), so Tavily is the only way in — we
can't just fetch the page and read `<a href>`s.

## Fix — phased

### Phase 1: Derive part URLs from TOC **titles**, not just hrefs

The extract reliably contains the TOC **title list**. Build candidate slugs from titles
using GameFAQs' slug convention, then keep only the ones that actually resolve.

- **Parse the TOC title block** from the extracted text (the "Table of Contents … "
  region, plus the visible part headings). New helper
  `parseGamefaqsTocTitles(content)` → ordered `["Introduction", "Frequently Asked
  Questions", "Part 1: The First Steps", …]`.
- **Title → slug** (`slugFromGamefaqsTitle`): kebab-case + GameFAQs quirks —
  `"Part 1: The First Steps"` → `part-1-the-first-steps`; known sections mapped
  explicitly (`Introduction`→`introduction`, `Frequently Asked Questions`→
  `frequently-asked-questions`, `Runes`→`runes`, …). This is heuristic; treat every
  constructed slug as a *candidate*.
- **Verify candidates cheaply** before trusting them: a candidate is real if Tavily
  Extract of `${canonicalUrl}/${slug}` returns non-blocked content (reuse the existing
  extract path). Batch + cap. Drop 404/blocked ones. This turns "guessed slugs" into a
  verified page list without depending on Tavily search's index.
- **Union** with the existing sources (Tavily search, `guide_chunks`, cache) — never
  shrink, matching today's merge policy.
- `parseGamefaqsTocFromHtml` (href regex) stays as the fast path; title-derivation is
  the fallback when it returns ≤1.

### Phase 2: Content-hash dedup at ingest (kills the 25×)

Independent of discovery — this is what stops `?print=1` from storing the whole guide N
times.

- At `storePendingPages` / `insertGuideChunks` (`lib/guide-ingest.ts`), compute a hash
  per chunk (`sha1(chunk_text)`). Before inserting a page's chunks for a bundle, skip
  any chunk whose hash already exists **for that bundle**. Add a `content_hash` column
  (or a unique index on `(guide_bundle, md5(chunk_text))`) — see `db/`.
- Effect: the 2nd…Nth "page" whose print-extract is the same full guide contributes **0
  new chunks**. Storage drops from 2290 → ~101 for a guide like `79809`.
- **Detect the print-returns-full-guide case early:** if page B's first-chunk hash
  equals page A's, B is the same content → mark B `not_found`-style "duplicate of A",
  stop extracting further siblings, and treat the bundle as effectively single-page
  (one ingest, all content). Saves Tavily credits too.

### Phase 3: Root-URL bundle detection (UX)

Pasting the guide's root URL (what you get when you open it) should Just Work.

- At add-time (`app/guide-link-field.tsx#previewGuideUrl`), when `parsed` is a GameFAQs
  FAQ URL with **no** `sectionSlug`, still run bundle discovery on it (don't fall
  straight to single-page). Show the page checklist when discovery yields ≥2 pages.
- Keep the single-page fallback when discovery genuinely finds one page.

### Phase 4 (pragmatic): "print-once" mode as the reliable floor

For guides where `?print=1` returns the **full** guide (like `79809`), the cleanest
model is to skip multi-page entirely: ingest the single print document once (chunked),
dedup guarantees no repetition. Detection: extract the print URL; if its content
already contains all/most TOC sections (Phase 1's title list all present in one
document), ingest it as one `singlePage` doc and mark the bundle complete. This is often
higher-fidelity than stitching flaky per-part extracts.

## Honest caveats (do not over-promise)

- GameFAQs may still block extraction of individual constructed part URLs — Phase 1
  verification will simply drop those; coverage stays partial (surface it via the
  existing `pagesMissing` + reason work).
- Title→slug construction is heuristic; the verify step is what makes it safe.
- `?print=1` behaviour is **per-guide inconsistent** (full guide vs one section) — Phase
  2 dedup + Phase 4 detection absorb both, but neither is guaranteed for every guide.
- **The 100%-reliable path remains file upload** (open the GameFAQs print view → save
  `.txt`/`.pdf` → Upload): one clean document, no discovery, no dedup needed. This plan
  narrows the gap for URL-paste; it does not make GameFAQs as reliable as a wiki or an
  uploaded file. Keep the in-app "Using GameFAQs? upload the file instead" hint.

## Ordering & ROI

1. **Phase 2 (dedup)** first — highest ROI, smallest surface, fixes the worst symptom
   (25× waste + retrieval-diversity loss) for *already-working* discoveries, and is a
   safety net for everything else.
2. **Phase 1 (title-derived TOC)** — makes previously-undiscoverable guides (`80674`)
   indexable.
3. **Phase 3 (root URL)** — UX, small.
4. **Phase 4 (print-once)** — optional reliability floor; do only if Phase 1 coverage
   stays poor in practice.

## DB

- `guide_chunks`: add `content_hash text` + a partial unique index
  `unique (guide_bundle, content_hash) where guide_bundle is not null` (new `db/*.sql`).
  Backfill existing rows' hashes once (or let it fill lazily on next ingest).

## Teardown

Grep: `parseGamefaqsTocTitles`, `slugFromGamefaqsTitle`, `content_hash`,
`print-once`, `gamefaqs_toc_discovery`. Revert restores Tavily-search-only discovery;
the `content_hash` column is additive/nullable (leave it).

## Cross-links

- Discovery: `lib/gamefaqs-discover.ts`, `lib/gamefaqs-bundle.js`
  (`parseGamefaqsTocFromHtml`, `isLikelySinglePageGamefaqsGuide`,
  `gamefaqsPrintExtractUrl`)
- Ingest + dedup site: `lib/guide-ingest.ts` (`storePendingPages`, `insertGuideChunks`,
  `ingestGamefaqsBundle`)
- Add-time detection: `app/guide-link-field.tsx#previewGuideUrl`
- Failed-page reason work (already shipped): the `pageStatus` / `failedPages` /
  `Retry` mechanism surfaces whatever stays un-indexed here
- Bundle behaviour contract: `CLAUDE.md` → "GameFAQs multi-page bundles"
