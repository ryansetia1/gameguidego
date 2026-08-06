# Top-tier guide providers

**Status:** Living architecture doc (July 2026).

## Product intent

GameGuideGo treats three walkthrough hosts as **first-class preferred-guide
sources**, not generic URLs:

| Provider | Primary module | Plan doc | Ingest status |
|----------|----------------|----------|---------------|
| **GameFAQs** | `lib/gamefaqs-bundle.js` | [`preferred-guide.md`](../preferred-guide.md) | **Shipped** (`?print=1` single-page) |
| **Neoseeker** | `lib/neoseeker-bundle.js` (planned) | [`neoseeker-bundle.md`](./neoseeker-bundle.md) | **Research** |
| **IGN** | `lib/ign-wiki.js` (planned) | [`ign-wiki-bundle.md`](./ign-wiki-bundle.md) | **Research** |

**North star:** paste one guide URL → ingest the **full book** (or the walkthrough
scope the user meant) → RAG answers with fidelity to that source.

Each provider gets a **dedicated system** (URL parser, extract path, discovery,
noise filter, bundle key). They share the same downstream pipeline; they do **not**
share one generic scraper.

---

## Why dedicated systems (not one-size-fits-all)

Sites differ enough that a single Tavily-only path leaves quality on the table:

| Concern | GameFAQs | Neoseeker | IGN wiki |
|---------|----------|-----------|----------|
| Direct HTTP | 403 Cloudflare | 403 Cloudflare | ✅ 200 |
| Best extract | Tavily `?print=1` | Tavily Extract | `__NEXT_DATA__` htmlEntities |
| Full guide shape | 1 URL = 1 book | 3 URL patterns (flat / nested / FAQ) | Multi-page wiki + next/prev chain |
| Discovery | None | Link cascade / hub parse | `nextPage` / `prevPage` crawl |
| Typical noise | TOC, GameFAQs CTAs | Wiki sidebar, comments | Site chrome (Tavily); callout boxes (HTML) |
| Bundle key | `gamefaqs:{faqId}` | `neoseeker:{slug}` or `neoseeker-faq:{slug}:{id}` | `ign-wiki:{wikiSlug}` |

Forcing all three through `extractGuidePage()` + Tavily works for **single-page
smoke tests** only. Top-tier coverage needs provider-specific ingest.

---

## Shared pipeline (unchanged)

All providers converge here after extract + clean:

```text
provider extract → clean/noise filter → chunkGuide → embed → guide_chunks
                                                              ↓
user question → resolveQuestion (forRag) → match_guide_chunks_hybrid → summarize
                                           (vector ∪ exact-name phrases)
```

Shared modules (do not fork per provider):

- `lib/chunk-guide.js`, `lib/embed.ts`, `lib/guide-rag.ts`, `lib/guide-rescore.js`
- `lib/guide-ingest.ts` — **router** only; branches to provider modules
- `lib/guide-urls.js` — paste validation, dedupe, legacy URL normalization
- `lib/guide-lexical.js` — proper-noun phrases for the lexical half of retrieval
- `public.guide_chunks` (incl. the `chunk_tsv` generated column),
  `public.guide_bundle_cache`, `match_guide_chunks_hybrid` RPC

Provider modules own **everything upstream** of `chunkGuide`.

---

## Ingest router (target shape)

`lib/guide-ingest.ts` (conceptual; Neoseeker + IGN not wired yet):

```text
normalizePreferredGuideUrl(url)
  ├─ isGamefaqsGuideUrl(url)     → gamefaqs path (Tavily ?print=1, quality gate)
  ├─ isNeoseekerGuideUrl(url)    → neoseeker-bundle (pattern A/B/C branch)
  ├─ isIgnWikiUrl(url)           → ign-wiki (htmlEntities fetch, optional bundle crawl)
  └─ else                        → generic Tavily extractGuidePage (PDF, arbitrary URL)
```

Each branch returns the same shape: `{ title, content }` per stored `guide_url`.

---

## Module map (planned + shipped)

```
lib/
  gamefaqs-bundle.js     ✅ URL canonicalize, print=1 quality gate, title parse
  neoseeker-bundle.js    📋 parseNeoseekerUrl, discoverNeoseekerPages, noise filter
  ign-wiki.js            📋 parseIgnWikiUrl, fetchIgnWikiPage, discoverIgnWikiChain
  guide-ingest.ts        router + shared embed/chunk persist
  guide-urls.js            host detection helpers (extend for ign/neoseeker canonical)
```

Calibration scripts (network):

- `scripts/test-neoseeker*.mjs`
- `scripts/test-ign-guide.mjs`

Unit tests: `npm run check` (URL parsers, bundle keys, no network).

---

## UI / UX (shared)

- `app/guide-link-field.tsx` — paste + web search picker (bias GameFAQs first in
  `discoverGuideLinks`; extend ranking when Neoseeker/IGN ship).
- `app/chat/use-guide-bundle.tsx` — per-URL ingest status, Retry, bundle progress.
- `hubWarning` — thin discovery (Neoseeker hub, IGN scope guard stop, GameFAQs TOC-only).

Provider-specific copy examples:

- GameFAQs: "Indexing guide…"
- Neoseeker: "Indexing Neoseeker guide (N pages)…"
- IGN: "Indexing IGN guide (N pages)…"

---

## Implementation order (suggested)

1. **GameFAQs hardening** — [`gamefaqs-print-hardening.md`](./gamefaqs-print-hardening.md)
2. **Neoseeker Phase 1** — Pattern C FAQ (closest to GameFAQs), then wiki A/B bundle
3. **IGN Phase 1** — single-page htmlEntities, then next/prev bundle + scope guard

Providers can ship independently; the router pattern keeps diffs isolated.

---

## Read before implementing

| Task | Read |
|------|------|
| Any preferred-guide / RAG work | [`preferred-guide.md`](../preferred-guide.md), `CLAUDE.md` GameFAQs section |
| Neoseeker | [`neoseeker-bundle.md`](./neoseeker-bundle.md) |
| IGN | [`ign-wiki-bundle.md`](./ign-wiki-bundle.md) |
| RAG quality knobs | [`rag-tuning-roadmap.md`](./rag-tuning-roadmap.md), [`rag-outline-rescore.md`](./rag-outline-rescore.md) |

When a provider phase ships, update this table, the provider plan doc status, and
`docs/plan/README.md`.
