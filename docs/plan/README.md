# Refactor & roadmap plans

Long-horizon engineering plans for GameGuideGo. These are **intent documents**:
they describe where the codebase is going, not necessarily what is shipped yet.

| Plan | Status | Summary |
|------|--------|---------|
| [chat-persistence-refactor.md](./chat-persistence-refactor.md) | **Active** | Chat messages, variants, and Supabase schema: stabilize JSONB, then hybrid tables |
| [chat-persistence-cutover-fixes.md](./chat-persistence-cutover-fixes.md) | **Planned** | Close review gaps from normalized cutover: read fallback, server save race, sync reliability |
| [page-decomposition.md](./page-decomposition.md) | **Done** | Split `app/page.tsx` into focused modules without behaviour change |

When a plan phase ships, update its status here and cross-link from `CLAUDE.md`.
