# Neoseeker preferred-guide bundle (research)

**Status:** Research / not implemented (July 2026).

Intent: make [Neoseeker](https://www.neoseeker.com) a **top-tier preferred-guide source**
alongside GameFAQs — paste one URL, ingest the full guide, answer via the
existing RAG pipeline (`guide_chunks` + `match_guide_chunks`).

Neoseeker is **not one layout**. Research found **three URL families**: flat wiki
walkthroughs, nested `/walkthrough/` chapter wikis, and legacy **FAQ single-page**
guides (GameFAQs-like). Parser and bundle logic must branch on pattern.

Related prior art:

- GameFAQs bundle: `lib/gamefaqs-bundle.js` + `?print=1` single-page ingest
- [GuideForge](https://github.com/Gerype150/GuideForge) (NeoseekerToPdf): Playwright
  discovery + BeautifulSoup `#wiki-content` cleaning → unified HTML/PDF
- Live calibration scripts: `scripts/test-neoseeker*.mjs` (see **Test scripts** below)

---

## Current state in GameGuideGo

| Capability | Status |
|------------|--------|
| Neoseeker in answer-time search whitelist | ✅ `lib/tavily.ts` (`WALKTHROUGH_SITE_DOMAINS`) |
| Neoseeker in visual-search allowlist | ✅ `lib/visual-search.js`, `lib/visual-image-proxy.js` |
| Single-URL preferred-guide ingest | ✅ Works today via Tavily Extract + `guide-ingest` |
| Multi-page bundle discovery | ❌ Not wired |
| Neoseeker-specific URL parser | ❌ Not wired |
| Neoseeker noise filter | ❌ Not wired (generic `cleanSnippet` only) |
| `hubWarning` for `/walkthrough` hubs | ❌ `looksLikeHub()` does not flag Neoseeker hubs |

**What works today:** user pastes one Neoseeker page URL → that page is extracted,
chunked, embedded, and RAG answers from it. Quality is good when the pasted page
matches the question; coverage is thin when only one chapter is indexed.

---

## Neoseeker guide anatomy

Neoseeker hosts guides in **three layouts**. Do not assume every URL is a
multi-page wiki.

### Pattern overview

| Pattern | URL shape | Ingest model | Closest analogue |
|---------|-----------|--------------|------------------|
| **A — flat wiki** | `/{slug}/{Page}` | Multi-page bundle (~40 URLs) | Hades sidebar wiki |
| **B — nested wiki** | `/{slug}/walkthrough/{Chapter}` | Multi-page bundle (~25–45 URLs) | GuideForge chapter crawl |
| **C — FAQ document** | `/{slug}/faqs/{id}-{name}.html` | **Single-page** (1 URL = full guide) | GameFAQs `?print=1` |

The same game slug can have **both** a wiki walkthrough and separate FAQ docs
(e.g. `pokemon-platinum` has `/walkthrough` and dozens of `/faqs/*.html` guides).
Those are **different products** — do not merge into one bundle.

### Shared HTML selectors (all pages)

| Element | Selector | Notes |
|---------|----------|-------|
| Game title | `#page-title` strong | Small label above h1 |
| Page title | `#page-title h1` | Chapter or guide name |
| Main content | `#wiki-content .mw-parser-output` | Ingest target |
| Global nav | `#wiki-navigation .wiki-toc` | Sidebar TOC; duplicated on every page |
| Prev / Home / Next | `#nav_prev_next` | Footer navigation |
| Inline TOC | `#toc` | Auto-generated on longer pages |

### URL patterns (three families)

Parser must detect pattern from the pasted URL and branch ingest logic.

#### Pattern A — flat wiki (sibling pages under game slug)

```
https://www.neoseeker.com/{game-slug}/{Page_Name}
https://www.neoseeker.com/hades-2020/walkthrough          ← hub
https://www.neoseeker.com/hades-2020/Tartarus             ← biome
https://www.neoseeker.com/hades-2020/Beginner%27s_Guide   ← guide
https://www.neoseeker.com/hades-2020/Zeus                 ← character
```

Example game: **Hades** (`hades-2020`).

Sidebar groups: Biomes, Character Guides, Guides, Appendix (~40 sibling pages).

#### Pattern B — nested (chapters under `/walkthrough/`)

```
https://www.neoseeker.com/{game-slug}/walkthrough                    ← hub
https://www.neoseeker.com/{game-slug}/walkthrough/Prologue           ← chapter
https://www.neoseeker.com/{game-slug}/walkthrough/01_-_Chapter_Name
https://www.neoseeker.com/{game-slug}/walkthrough/Section:_Subpart  ← colon sub-parts
```

Example games: **Uncharted 4** (`uncharted-4`), **The Last of Us** (`the-last-of-us`).

Some nested guides also have **parent section URLs** (e.g. `walkthrough/Pittsburgh`)
alongside **granular sub-chapters** (e.g. `walkthrough/Pittsburgh:_Hotel_Lobby`).
Prefer granular URLs for walkthrough RAG when both exist.

#### Pattern C — FAQ single document (legacy FAQ host)

```
https://www.neoseeker.com/{game-slug}/faqs/                    ← index (lists many guides)
https://www.neoseeker.com/{game-slug}/faqs/{id}-{slug}.html    ← one full guide
```

Example: [Pokémon Platinum strategy FAQ](https://www.neoseeker.com/pokemon-platinum/faqs/177563-pokemon-dp-strategy.html)
(`pokemon-platinum`, faq id `177563`).

**Key facts (July 2026 test):**

- **One `.html` URL = the entire guide** in a single Tavily extract (like GameFAQs
  `?print=1`). No chapter discovery step.
- Strategy FAQ: **249,063 chars** raw → **131 chunks** after `cleanSnippet` + `chunkGuide`.
- Walkthrough FAQ (`177385-walkthrough.html`): **~3.6M chars** raw — full game
  walkthrough in one page; ingest cost ceiling applies (see **Cost** below).
- FAQ **index** (`/{slug}/faqs/`) lists **27+ separate guides** (moveset FAQ, battle
  frontier, walkthrough FAQ, etc.). These are **independent documents**, not chapters
  of one book. **Do not** auto-ingest the whole index when user pastes one FAQ.
- HTML is **legacy neo2k7 FAQ layout**, not `#wiki-content` MediaWiki. Noise includes
  "would you recommend this guide? yes no", old skin chrome.
- Internal section headers are often **plain uppercase lines** (`UPDATE TO POLICY`,
  `BORDERLINE`), not markdown `#` headings — chunking may fall back to paragraph split.

**URL parse:**

```text
/{slug}/faqs/{numericId}-{humanSlug}.html
→ bundleKey: neoseeker-faq:{slug}:{numericId}
→ canonicalUrl: strip query/hash, keep .html path
```

### Canonical bundle keys (proposed)

**Multi-page wiki** (Pattern A or B):

```
neoseeker:{game-slug}
```

Any walkthrough/wiki paste under the same `{game-slug}` resolves to one page list.
Store discovered URLs in `guide_bundle_cache`.

**FAQ single document** (Pattern C):

```
neoseeker-faq:{game-slug}:{faq-id}
```

One FAQ per bundle. Pasting `/{slug}/faqs/` index should **not** expand to all FAQs;
either ingest index as a thin hub with `hubWarning`, or require a specific `.html` URL.

---

## Extraction & anti-bot

| Method | Result (July 2026 tests) |
|--------|-------------------------|
| Direct `fetch` / `requests` | **403 Cloudflare** on all tested pages |
| MediaWiki `api.php` | **403** |
| `robots.txt` / `sitemap.xml` | sitemap **403**; robots allows `search=yes` |
| **Tavily Extract** | ✅ Works; bypasses Cloudflare |
| **Playwright** (GuideForge) | ✅ Works; full DOM including sidebar |
| Wayback hub HTML parse | ❌ Unreliable (0 sidebar links on Hades hub snapshot) |
| Serper `site:neoseeker.com/{slug}` | ❌ 0–2 URLs; cannot enumerate full wiki |

**Conclusion:** production ingest should stay on **Tavily Extract** per page.
Playwright is optional fallback for discovery only, not required for most guides
(see cascade below).

---

## Discovery without Playwright

**Pattern C (FAQ):** skip discovery entirely. One pasted `.html` URL is the full
guide. Ingest path mirrors GameFAQs single-page extract.

**Pattern A / B (wiki):** multi-page discovery below.

### How to discover wiki pages from one pasted URL

1. **Tavily raw/advanced extract** the seed URL (preserve markdown links).
2. **Parse links** matching the game slug (flat + nested patterns).
3. **Normalize** URLs (lowercase host, strip hash, decode `%27`, drop `File:` /
   `Special:`, strip markdown artifacts like `)%201`).
4. If link count **< `MIN_BUNDLE_PAGES` (15)** → run cascade probes (below).
5. **Cache** final URL list per `neoseeker:{slug}` in `guide_bundle_cache`.
6. **Ingest** each URL via existing `extractGuidePage` → `chunkGuide` → embed.

### Link parser regex (proposed)

Must match wiki patterns (Pattern A/B) and allow `:` in chapter slugs (TLOU sub-parts):

```text
neoseeker.com/{slug}/faqs/{id}-{name}.html   ← Pattern C (single doc; no discovery)
neoseeker.com/{slug}/walkthrough/{chapter}   ← Pattern B nested
neoseeker.com/{slug}/{page}                  ← Pattern A flat
```

Do **not** treat `/faqs/` index links as wiki chapter URLs.

Allowed slug chars: `A-Za-z0-9_%'(). -:` (colon required for TLOU-style names).

Filter out:

- `/Special:`, `/File:`, `/Image:`, `/forums/`
- Empty or `)`-suffix artifacts from broken markdown
- Duplicate URLs after normalization

### Discovery cascade (when seed is thin)

Tested on Hades when flat parser finds < 15 links:

| Step | Action |
|------|--------|
| 1 | Tavily extract seed URL |
| 2 | If < 15 links → extract canonical hub `/{slug}/walkthrough` |
| 3 | If still < 15 → probe **frontier URLs** found so far (including `File:` pages — on Hades hub, `File:Hades_Art.jpg` extract contains full sidebar) |
| 4 | If still < 15 → Serper search `"{game}" site:neoseeker.com/{slug}` + extract top hits |
| 5 | Merge, dedupe, cache |

**Hades hub-only** reaches full bundle in **2 Tavily probes** via accidental
`File:` frontier. **Uncharted 4** and **TLOU** hubs need **1 probe** (hub extract
already contains all chapter links with nested parser).

Serper alone is **not** sufficient for enumeration.

---

## Calibration results (July 2026)

Environment: local dev, `TAVILY_API_KEY` + `SERPER_API_KEY` set. No Playwright.

### Summary table

| Game | Slug | Pattern | Hub / seed chars | Pages / bundle | Full guide? | Cascade? |
|------|------|---------|------------------|----------------|-------------|----------|
| Hades | `hades-2020` | **A Flat wiki** | 1,842 (hub) | 45 (cascade) | ⚠️ Hub needs cascade | **Yes** |
| Uncharted 4 | `uncharted-4` | **B Nested wiki** | 26,365 (hub) | **41** | ✅ 1 extract | No |
| The Last of Us | `the-last-of-us` | **B Nested wiki** | 22,325 (hub) | **40** granular | ✅ 1 extract | No |
| Pokémon Platinum | `pokemon-platinum` | **C FAQ doc** | 249,063 (one `.html`) | **1 URL → 131 chunks** | ✅ 1 extract | **No** |

Full bundle threshold for **wiki** patterns: **≥ 15 unique page URLs**.
Pattern C is always a single URL; "full" means extract length ≥ `MIN_GUIDE_CHARS`.

### Hades (`hades-2020`)

**Hub** (`/walkthrough`):

- Tavily strips inline TOC links; extract is thin (intro + controls table only).
- Single extract: **1 link** (`File:Hades_Art.jpg`).
- Cascade: seed → probe File page → **45 links** (~96% overlap with Tartarus ground truth).

**Fat pages** (Beginner's Guide, Tartarus):

- Single extract: **44–46 links**; full bundle immediately.
- Sidebar present in Tavily raw markdown.

**Short pages** (Zeus):

- Single extract: **1 link**; cascade via File frontier → **45 links**.

**RAG smoke test** (single-page ingest, no bundle):

- "What are boons?" + Beginner's Guide → ✅ correct
- "Zeus jolted curse?" + Beginner's Guide → ✅ correct
- "Beat Megaera?" + Tartarus → ✅ correct

**Noise in chunks:** ~30% of Beginner's Guide chunks were site nav, comments form,
or "Support Neoseeker" footer. Needs Neoseeker-specific cleaning.

### Uncharted 4 (`uncharted-4`)

**Hub** (`/walkthrough`):

- **26,365 chars**; nested parser finds **41 pages** in one extract.
- Chapters: `walkthrough/Prologue`, `01_-_The_Lure_of_Adventure` … `22_-_A_Thiefs_End`,
  plus Treasures, Trophies, Tips, etc.
- Flat parser finds only **3 links** → would **fail** without nested support.

**Chapter probe** (`/walkthrough/01_-_The_Lure_of_Adventure`):

- 31,099 chars; **41 links** — any chapter page also exposes full TOC.

### The Last of Us (`the-last-of-us`)

**Hub** (`/walkthrough`):

- **22,325 chars**; **43 raw link mentions** in extract.
- Nested parser **with colon support**: **40 granular** sub-chapters.
- Nested parser **without `:`**: only **25 parent sections** (misses e.g.
  `Pittsburgh:_Hotel_Lobby`).
- Flat parser: **2 links** → fail.

**Two-tier structure:** parent sections (`walkthrough/Pittsburgh`) and granular
sub-chapters (`walkthrough/Pittsburgh:_Hotel_Lobby`). Ingest granular URLs for
walkthrough Q&A.

**Chapter probe** (`/walkthrough/Basic_Enemy_Tactics`):

- 17,852 chars; **24 links** (parent-level TOC on sub-page).

### Pokémon Platinum (`pokemon-platinum`) — Pattern C FAQ

Test URL: [`/faqs/177563-pokemon-dp-strategy.html`](https://www.neoseeker.com/pokemon-platinum/faqs/177563-pokemon-dp-strategy.html)
(Diamond/Pearl/Platinum Strategies/Counter Strategies FAQ v3.6).

**Single FAQ document:**

- Tavily advanced extract: **249,063 chars** (one page, no chapter links inside).
- After `cleanSnippet`: **246,555 chars** → **131 chunks**.
- Internal structure: uppercase section labels (`UPDATE TO POLICY`, `BORDERLINE`, …),
  not MediaWiki `#wiki-content` headings.
- **No multi-page discovery** — paste this URL = ingest complete guide.

**FAQ index** (`/pokemon-platinum/faqs/`):

- Extract: **29,694 chars**; lists **27+ separate FAQ** `.html` URLs (moveset, battle
  frontier, walkthrough FAQ, etc.).
- **Not** a chapter list for one guide — each `.html` is its own product.
- Do not auto-bundle all FAQs when user pastes the index.

**Same game, separate wiki walkthrough** (`/pokemon-platinum/walkthrough`):

- Thin extract in test (**8,084 chars**); separate from FAQ system.
- A walkthrough also exists as FAQ doc `177385-walkthrough.html` (**~3.6M chars** in
  one page — largest single-doc seen; needs ingest cap / quality gate).

**vs GameFAQs:** Pattern C is the closest match — canonical key per FAQ id, single
Tavily extract, chunk full text. Reuse GameFAQs ingest mental model; different HTML
noise profile (neo2k7 skin vs GameFAQs print view).

---

## GuideForge learnings (Playwright reference)

[GuideForge](https://github.com/Gerype150/GuideForge) solves the same problem for
PDF export. Useful pieces to port; browser automation optional for MVP.

| GuideForge piece | Port to GameGuideGo? |
|------------------|----------------------|
| `get_chapter_urls()` — Playwright + all `<a>` with slug prefix | Optional fallback; cascade covers most cases |
| `_chapter_prefix()` — derive `/{slug}/` from any seed URL | ✅ Port to `lib/neoseeker-bundle.js` |
| `html_cleaner.py` — `#wiki-content`, strip ads/comments/`section-vu` | ✅ Port selectors to ingest post-process |
| `requests` per-chapter fetch after Playwright | ❌ Use Tavily instead (requests gets 403) |
| Unified `guide.html` merge | ❌ Not needed; per-page chunks in `guide_chunks` |

GuideForge confirms: **paste hub URL → discover all chapters** is possible when the
DOM is fully rendered. Our Tavily-based cascade achieves the same for most games
without Playwright.

---

## Cleaning / noise (from tests + GuideForge)

Apply after Tavily extract, before `chunkGuide`:

**Drop or strip:**

- Site header nav (`Games`, `Forums`, `PC`, `PS4`, `Login`, `Register`, …)
- `#wiki-navigation` sidebar text if present in extract
- `#nav_prev_next` (Prev / Home / Next)
- `#comments`, comment forms ("Add your comment", "Members please LOGIN")
- `Support Neoseeker` footer blocks
- `#toc` duplicate inline TOC (optional; outline metadata may prefer headings)
- Ad blocks: `.section-vu`, `[class*='ad-']`, iframe embeds

**Keep:**

- `#wiki-content` body: headings, paragraphs, tables (`wikitable`), lists
- Spoiler text (expand inline, per GuideForge)

GuideForge selectors: `#page-title`, `#wiki-content`, last `<hr>` + `.clearfix`
footer removal.

---

## vs GameFAQs

| Aspect | GameFAQs | Neoseeker wiki (A/B) | Neoseeker FAQ (C) |
|--------|----------|----------------------|-------------------|
| Paste 1 URL → full guide | ✅ `?print=1` | ✅ With bundle discovery | ✅ **One `.html` URL** |
| Pages per guide | 1 | ~25–45 | **1** |
| Tavily extracts per full ingest | 1 | ~25–45 | **1** |
| Bundle key | `gamefaqs:{faqId}` | `neoseeker:{slug}` | `neoseeker-faq:{slug}:{id}` |
| Discovery step | None | Cascade for thin hubs | **None** |
| Max size seen | ~500k chars | ~25k/chapter | **~3.6M** (walkthrough FAQ) |

Neoseeker can match GameFAQs **answer quality** when the right pages are indexed;
cost per full ingest is **~25–45×** one Tavily extract (mitigate with skip-if-chunked,
bundle cache, single-flight lease).

---

## Proposed implementation (not built yet)

### New module: `lib/neoseeker-bundle.js`

```text
parseNeoseekerUrl(rawUrl)
  → { gameSlug, pattern: 'flat'|'nested'|'faq', faqId?, pageSlug?, hubUrl, bundleKey }

discoverNeoseekerPages(seedUrl)   // Pattern A/B only; returns [] for Pattern C
normalizeNeoseekerPageUrl(url)
isNeoseekerGuideUrl(url)
canonicalNeoseekerHub(slug)       // /{slug}/walkthrough
canonicalNeoseekerFaqUrl(raw)     // /{slug}/faqs/{id}-{slug}.html
filterNeoseekerNoise(text)        // wiki + neo2k7 FAQ chrome
```

### Ingest flow changes (`lib/guide-ingest.ts`)

1. If `isNeoseekerGuideUrl(url)`:
   - **Pattern C (`/faqs/{id}-*.html`):** single-page ingest (like GameFAQs). One
     `guide_url` = canonical FAQ URL. No `discoverNeoseekerPages`.
   - **Pattern A/B:** resolve `bundleKey = neoseeker:{slug}`, discover page list,
     multi-page ingest (existing plan).
2. Surface `hubWarning` when wiki discovery < 15 after cascade, or when user pastes
   `/{slug}/faqs/` index (lists many guides — not one book).
3. UI: "Indexing Neoseeker guide (N pages)…" progress (wiki) or single-page for FAQ.

### DB

Reuse existing tables:

- `guide_chunks.guide_url` — one row set per page URL (wiki) or per FAQ `.html`
- `guide_bundle_cache.bundle_key` — `neoseeker:{slug}` (wiki page list) or
  `neoseeker-faq:{slug}:{faqId}` (title/metadata only for FAQ)

No schema migration required for MVP.

### `looksLikeHub` extension

```text
pathname ends with /walkthrough AND discovery page count < MIN_BUNDLE_PAGES
```

---

## Test scripts

Run from repo root (requires `.env.local` with `TAVILY_API_KEY`):

| Script | Purpose |
|--------|---------|
| `node scripts/test-neoseeker.mjs` | Tavily extract + ingest API smoke (Hades) |
| `node scripts/test-neoseeker-discovery.mjs` | Sidebar link discovery from seed URLs |
| `node scripts/test-neoseeker-no-playwright.mjs` | Full cascade test (Hades seeds) |
| `node scripts/test-neoseeker-uncharted4.mjs` | Uncharted 4 hub + nested parser |
| `node scripts/test-neoseeker-tlou.mjs` | The Last of Us hub + colon sub-chapters |

### Adding a new calibration game

1. Copy `scripts/test-neoseeker-tlou.mjs` → `scripts/test-neoseeker-{slug}.mjs`.
2. Set `SLUG`, `HUB`, `GAME`.
3. Run; record hub chars, flat vs nested link counts, cascade need.
4. Append row to **Calibration results** table in this doc.

---

## Open questions / risks

1. **Three patterns, not two** — FAQ `.html` is single-doc; wiki is multi-page. Never
   merge `/faqs/` index into one walkthrough bundle.
2. **FAQ size ceiling** — `177385-walkthrough.html` hit **~3.6M chars**; need max-chars
   gate or `focusSection`-style trim before embed (ponytail: cap in ingest, not unbounded).
3. **File-page frontier trick** (Hades wiki): works on tested guides but not proven universal.
4. **Colon in slug regex**: required for TLOU nested sub-chapters.
5. **Parent vs granular wiki URLs**: prefer longest path per section to avoid duplicate chunks.
6. **Parse artifacts**: markdown link tails like `)%204` need normalization.
7. **Cost ceiling**: wiki = 40 pages × Tavily; FAQ = 1 × Tavily but can be huge.
8. **FAQ HTML ≠ wiki HTML** — noise filter needs neo2k7 FAQ rules separately from `#wiki-content`.

---

## Recommended phases

| Phase | Scope | Outcome |
|-------|-------|---------|
| **0** | This doc + test scripts | ✅ Done |
| **1** | `lib/neoseeker-bundle.js` parse (3 patterns) + FAQ canonical URL | Paste FAQ `.html` works like GameFAQs |
| **2** | Wiki discover + multi-page ingest | Full walkthrough bundle |
| **3** | Noise filter (GuideForge selectors) | Clean chunks |
| **4** | UI progress + `hubWarning` toast | User feedback |
| **5** | Guide search ranking boost for Neoseeker | Easier discovery in picker |

---

## Next steps when implementing

1. Read this doc + `lib/gamefaqs-bundle.js` (pattern reference).
2. Run all `scripts/test-neoseeker*.mjs` against target game before coding.
3. Implement `parseNeoseekerUrl` + `discoverNeoseekerPages` with flat + nested + colon.
4. Wire `guide-ingest.ts` bundle branch; RAG already filters by `preferredUrls` array.
5. Add one `npm run check` self-test for URL parsing (no network).
6. Update `CLAUDE.md` when Phase 1–2 ship.
