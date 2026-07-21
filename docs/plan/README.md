# Refactor & roadmap plans

Long-horizon engineering plans for GameGuideGo. These are **intent documents**:
they describe where the codebase is going, not necessarily what is shipped yet.

| Plan | Status | Summary |
|------|--------|---------|
| [chat-persistence-refactor.md](./chat-persistence-refactor.md) | **Active** | Chat messages, variants, and Supabase schema: stabilize JSONB, then hybrid tables |
| [page-decomposition.md](./page-decomposition.md) | **Active** | Split `app/page.tsx` into focused modules without behaviour change |

When a plan phase ships, update its status here and cross-link from `CLAUDE.md`.
