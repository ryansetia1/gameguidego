# IGN wiki preferred-guide bundle (research)

**Status:** Research / not implemented (July 2026).

Intent: make [IGN wikis](https://www.ign.com/wikis) a **top-tier preferred-guide source**
alongside GameFAQs and Neoseeker — paste one chapter URL, ingest the full walkthrough,
answer via the existing RAG pipeline.

**Architecture:** IGN is a **dedicated provider system** (`lib/ign-wiki.js`), not an
extension of the generic Tavily extract path. See the three-provider overview in
[`guide-providers.md`](./guide-providers.md).

Related:

- Provider hub: [`guide-providers.md`](./guide-providers.md)
- Neoseeker (different stack): [`neoseeker-bundle.md`](./neoseeker-bundle.md)
- GameFAQs single-page: `lib/gamefaqs-bundle.js` + `?print=1`
- Live calibration: `scripts/test-ign-guide.mjs`

---

## Dedicated system (`lib/ign-wiki.js`)

IGN wikis are Next.js pages. Full article text lives in `__NEXT_DATA__`, not in the
DOM slice Tavily returns. A top-tier IGN integration **must** own:

| Responsibility | Owner |
|----------------|--------|
| URL parse + canonical redirect | `parseIgnWikiUrl`, `canonicalIgnWikiUrl` |
| Page fetch (direct HTTP, no Tavily primary) | `fetchIgnWikiPage` |
| HTML → plain text (tables, headings, callouts) | `htmlEntitiesToText` |
| Multi-page discovery | `discoverIgnWikiChain` (next/prev + scope guard) |
| Bundle metadata cache key | `ign-wiki:{wikiSlug}` |
| IGN-specific noise strip | `filterIgnWikiNoise` (optional phase 3) |

**Do not** fold this into `gamefaqs-bundle.js` or `neoseeker-bundle.js`. The ingest
router in `guide-ingest.ts` dispatches by host; shared code stops at `chunkGuide`.

Tavily remains a **degraded fallback** only when `__NEXT_DATA__` parse fails.

---

## Current state in GameGuideGo

| Capability | Status |
|------------|--------|
| IGN in answer-time search whitelist | ✅ `lib/tavily.ts` (`WALKTHROUGH_SITE_DOMAINS`) |
| IGN in visual-search allowlist | ✅ |
| Single-URL preferred-guide ingest via Tavily | ⚠️ **Works but thin** (~5k chars/page; misses most body) |
| IGN-specific fetch / `__NEXT_DATA__` parser | ❌ Not wired |
| Multi-page bundle (next/prev crawl) | ❌ Not wired |
| Legacy `/walkthroughs/` URLs | ❌ **404** on tested games (treat as redirect/migrate UX only) |

**What works today:** user pastes an IGN wiki URL → Tavily Extract indexes a **short**
markdown slice with site chrome noise. Enough for a lucky one-off question on that
chapter; **not** full-guide coverage.

---

## URL anatomy

### Pattern A — IGN wiki (primary, current)

```
https://www.ign.com/wikis/{wiki-slug}/{page-slug}
```

Examples:

| Game | wiki-slug | Chapter |
|------|-----------|---------|
| Pokémon D/P/Pt | `pokemon-diamond-pearl-platinum-version` | `Route_201_to_Sandgem_Town` |
| Elden Ring | `elden-ring` | `Stormveil_Castle` → redirects to `Stormveil_Castle_Location_and_Walkthrough` |
| Walkthrough hub | `…/Walkthrough` | Often a **section index**, not a linear chapter |

**User example (calibration):**
[Route 201 to Sandgem Town](https://www.ign.com/wikis/pokemon-diamond-pearl-platinum-version/Route_201_to_Sandgem_Town)

### Pattern B — legacy `/walkthroughs/` (retired)

```
https://www.ign.com/walkthroughs/{slug}
https://www.ign.com/walkthroughs/{slug}/page-2
```

Tested URLs (`pokemon-diamond-version`, `elden-ring`) return **404** (July 2026).
The codebase still references `/walkthroughs/` in `scripts/check.mjs` fixture URLs only.
**Do not** build ingest around this path; normalize pasted links to `/wikis/` when
possible (search or redirect follow).

### Cross-slug links inside content

Article HTML inside `htmlEntities` often links to a **different** wiki slug than the
page URL. Example: chapter under `pokemon-diamond-pearl-platinum-version` links to
`/wikis/pokemon-diamond-version/Bidoof`. Bundle discovery must key on **canonical
fetched URL**, not inline link host/slug alone.

---

## Page technology

| Layer | Detail |
|-------|--------|
| Framework | Next.js (`__NEXT_DATA__` in HTML) |
| Direct `fetch` | ✅ **200 OK**, ~220–630k HTML (no Cloudflare block unlike Neoseeker) |
| Tavily Extract | ⚠️ ~5–6k chars (basic + advanced); **no** usable internal wiki link list |
| Article body | `props.pageProps.page.page.htmlEntities[]` → `values.html` (WikiPageElement) |
| Title | `page.page.title` (ignore misleading site `h1` "All Interactive Maps…" on some pages) |
| Linear nav | `page.page.nextPage` / `prevPage` → `{ label, url }` (slug relative to wiki) |
| Redirects | Common (`Stormveil_Castle` → `Stormveil_Castle_Location_and_Walkthrough`) |

**Critical:** full guide text is **not** in the visible DOM slice Tavily returns. Ingest
must parse `__NEXT_DATA__` (or a future official API), not Tavily-only.

---

## Content extraction (proposed)

```text
GET /wikis/{slug}/{page}
  → parse __NEXT_DATA__
  → page.page.htmlEntities[].values.html
  → strip HTML (headings, tables, gh-blue-box callouts)
  → cleanSnippet → chunkGuide → embed
```

### Calibration (July 2026)

| Page | htmlEntities | raw HTML | stripped text | chunks |
|------|--------------|----------|---------------|--------|
| Pokémon `Route_201_to_Sandgem_Town` | 17 | 7.4k | 3.7k | 5 |
| Pokémon hub (`Walkthrough` → BDSP walkthrough) | 24 | 12.4k | 2.3k | 10 |
| Elden Ring `Walkthrough` hub | 27 | 16.6k | 7.3k | 10 |
| Elden Ring `Stormveil_Castle` | 174 | **135.6k** | **44.4k** | **28** |

Tavily on the same Pokémon chapter: 4.9k raw → 3.5k cleaned → 7 chunks, with chrome
noise (`Task Search`, `Checklists`, `Was this guide helpful`, `Up Next`, etc.).

**htmlEntities path is cleaner and complete** for article body; Tavily is a fallback only.

---

## Discovery (multi-page bundle)

### Mechanism 1 — `nextPage` / `prevPage` chain (best signal)

Every wiki page exposes linear navigation:

```json
"nextPage": { "label": "Route 202 to Jubilife City", "url": "Route_202_to_Jubilife_City" }
"prevPage": { "label": "Getting to Know Twinleaf Town", "url": "Getting_to_Know_Twinleaf_Town" }
```

Resolve: `https://www.ign.com/wikis/{wiki-slug}/{nextPage.url}`

**Pokémon calibration:** starting at `Route_201_to_Sandgem_Town`, the forward chain
walks the main story, then **bleeds into** Pokedex / legendary / "Best Pokemon" pages
after ~14 story chapters. A blind full forward crawl **over-collects**.

**Mitigation (ponytail):**

1. Seed from user paste; crawl **both** directions until `prevPage`/`nextPage` ends or
   **scope guard** trips.
2. Scope guard heuristics: stop when `nextPage.label` matches
   `Pokedex|Legendary|Best Pokemon|How to Get|Version Exclusives|Post Game` OR when
   leaving a breadcrumb "walkthrough" section (future: read sidebar section title).
3. Optional: user picks "Walkthrough only" vs "Full wiki" at paste time (phase 2).

### Mechanism 2 — sidebar / HTML link scrape (partial)

Full HTML for a walkthrough chapter contains ~10 same-wiki links (neighbors + top
sections). **Not** enough for full bundle alone; useful as hub fallback.

`/Walkthrough` hub for Pokémon redirects to **Brilliant Diamond and Shining Pearl
Walkthrough** (remake-focused intro), not the DS chapter list — **slug/content drift**
risk when game has multiple editions under one wiki.

### Mechanism 3 — Tavily link parse

**Failed** for IGN wikis: 0 chapter URLs discovered from hub/chapter extracts.

### Mechanism 4 — Serper `site:ign.com/wikis/{slug}`

Not tested yet; may help hub paste when next/prev is missing. Lower priority than
next/prev because direct fetch is cheap.

---

## Noise filter (proposed)

Tavily markdown includes global IGN chrome. `htmlEntities` HTML is mostly article, but
still has:

| Noise | Source |
|-------|--------|
| `gh-blue-box` / `gh-red-box` | Tip callouts (keep text, strip wrapper) |
| Inline wiki links to other slugs | Keep anchor text; normalize URLs at display |
| Author byline / "Updated: …" | Strip from first entity |
| "Was this guide helpful?" / footer | Tavily only (not in htmlEntities) |
| Map widgets / interactive | Elden pages — may yield thin text on map-only URLs |

Reuse GuideForge-style selector stripping where HTML is kept; otherwise strip tags.

---

## vs GameFAQs and Neoseeker

| Aspect | GameFAQs | Neoseeker wiki | IGN wiki |
|--------|----------|----------------|----------|
| Dedicated module | `gamefaqs-bundle.js` ✅ | `neoseeker-bundle.js` 📋 | `ign-wiki.js` 📋 |
| Paste 1 URL → full guide | ✅ `?print=1` | ✅ With discovery | ✅ With next/prev crawl |
| Primary extract | Tavily `?print=1` | Tavily Extract | Direct fetch + `__NEXT_DATA__` |
| Direct HTTP | 403 | 403 | ✅ 200 |
| Discovery | None | Link cascade / hub | `nextPage` / `prevPage` |
| Bundle key | `gamefaqs:{faqId}` | `neoseeker:{slug}` | `ign-wiki:{wikiSlug}` |
| Playwright needed? | No | No (MVP) | **No** |

Full three-provider architecture: [`guide-providers.md`](./guide-providers.md).

---

## Proposed implementation

### `lib/ign-wiki.js` (new)

- `parseIgnWikiUrl(url)` → `{ wikiSlug, pageSlug, pattern: 'wiki' | 'walkthroughs-legacy' }`
- `fetchIgnWikiPage(url)` → follow redirects, parse `__NEXT_DATA__`
- `htmlEntitiesToText(entities)` → strip HTML, preserve headings/tables
- `discoverIgnWikiChain(seedUrl, { maxPages, scope: 'walkthrough' })` → next/prev BFS
- `canonicalIgnWikiUrl(url)` → final URL after redirect
- `bundleKey(wikiSlug)` → `ign-wiki:{wikiSlug}`

### `lib/guide-ingest.ts` branch

1. If `isIgnWikiUrl(url)`:
   - Fetch page via `fetchIgnWikiPage` (not Tavily).
   - If bundle mode (preferred URL is walkthrough chapter or hub): discover chain,
     ingest each page (dedupe by canonical URL).
   - Else: single-page ingest (current chapter only).
2. Fail-open: if `__NEXT_DATA__` parse fails, fall back to Tavily Extract (degraded).

### DB

- `guide_chunks.guide_url` — one row set per wiki page URL (canonical after redirect)
- `guide_bundle_cache.bundle_key` — `ign-wiki:{wikiSlug}` → `{ pages: string[], title? }`

### UI

- Paste detector: accept `ign.com/wikis/…`; toast if `/walkthroughs/` 404 with hint to
  open the wiki guide on IGN.
- Progress: "Indexing IGN guide (N pages)…"
- `hubWarning` when discovery < 5 or scope guard stopped early.

### Tests

- `scripts/test-ign-guide.mjs` — extract + discovery smoke (network)
- `npm run check` — URL parser unit tests (no network)

---

## Risks / known limits

1. **Scope creep on next/prev crawl** — story walkthrough merges into Pokedex/guides;
   needs scope guard or explicit user scope.
2. **Edition drift** — one wiki slug covers multiple releases (DS vs BDSP); hub text
   may not match player's game.
3. **Cross-slug links** — content references `pokemon-diamond-version` while room is
   `pokemon-diamond-pearl-platinum-version`.
4. **Huge single pages** — Elden Ring chapters can be 28+ chunks each; full bundle
   may be hundreds of chunks (embed cost). Consider `maxPages` cap or walkthrough-only
   seed.
5. **Map-heavy pages** — some URLs are interactive map shells with little prose.
6. **`/walkthroughs/` dead** — old links in the wild; normalize or search-fallback.
7. **Terms of use** — direct fetch + parse is standard for user-pasted URLs; rate-limit
   server fetches (ponytail: sequential ingest with delay, cache in `guide_chunks`).

---

## Test scripts

```bash
node scripts/test-ign-guide.mjs
```

Requires `TAVILY_API_KEY` for Tavily comparison arm; direct fetch tests need no keys.

---

## Phased rollout

| Phase | Scope |
|-------|--------|
| 0 | This doc + calibration script ✅ |
| 1 | `lib/ign-wiki.js` parse + single-page htmlEntities ingest |
| 2 | next/prev discovery + multi-page bundle + scope guard |
| 3 | Noise strip + ingest size caps |
| 4 | UI hints (`/walkthroughs/` migrate, progress) |
| 5 | Search ranking / guide picker bias toward IGN wikis |
