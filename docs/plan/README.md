# Refactor & roadmap plans

Long-horizon engineering plans for GameGuideGo. These are **intent documents**:
they describe where the codebase is going, not necessarily what is shipped yet.

| Plan | Status | Summary |
|------|--------|---------|
| [chat-persistence-refactor.md](./chat-persistence-refactor.md) | **Active** | Chat messages, variants, and Supabase schema: stabilize JSONB, then hybrid tables |
| [chat-persistence-cutover-fixes.md](./chat-persistence-cutover-fixes.md) | **Done** | Close review gaps from normalized cutover (Phases 1–7) |
| [page-decomposition.md](./page-decomposition.md) | **Done** | Split `app/page.tsx` into focused modules without behaviour change |
| [rag-tuning-roadmap.md](./rag-tuning-roadmap.md) | **Research** | RAG chunk/K/threshold tuning and reranker upgrade backlog (July 2026) |
| [image-character-recognition.md](./image-character-recognition.md) | **Experimental** | Prompt-only vision character naming — try in prod, revert if quality drops |
| [user-memory.md](./user-memory.md) | **Experimental** | Opt-in player style memory — daily summarize, 5/10 tiers, profile UI |
| [player-memory-game-lifecycle.md](./player-memory-game-lifecycle.md) | **Planned** | Delete-game memory choice, per-game forget, not-in-library badge, catalog ID matching (Phases 1–4) |
| [answer-satisfaction-signals.md](./answer-satisfaction-signals.md) | **Future** | Retry / feedback as answer-quality signals — phased experiment backlog |
| [guide-web-override.md](./guide-web-override.md) | **Shipped** | **Search web instead** + **Also search web** toggles when a preferred guide is attached |
| [visual-search-rewrite-fold.md](./visual-search-rewrite-fold.md) | **Shipped** | Visual-intent detection folded into the rewrite (any language) + dropped the `visual_query` LLM call; auto-image by default with one global profile toggle (replaced the per-topic `+` menu toggle) |
| [gamefaqs-toc-discovery.md](./gamefaqs-toc-discovery.md) | **Shipped** | Fix GameFAQs bundle discovery: derive part URLs from TOC titles (not Tavily search) + content-hash dedup (kill the 25× duplication) + retrieval dedup + root-URL detection |
| [topic-title-in-summarize.md](./topic-title-in-summarize.md) | **Planned** | Fold first-turn `topicTitle` into `summarize` JSON — drop the third Gemini call (includes revert steps) |

When a plan phase ships, update its status here and cross-link from `CLAUDE.md`.
