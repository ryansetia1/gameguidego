# `app/page.tsx` decomposition plan

**Status:** In progress (Phase 4 started)  
**Depends on:** [chat-persistence-refactor.md](./chat-persistence-refactor.md) Phase 3 (complete)

## Problem

`app/page.tsx` is ~4800 lines and owns:

- Auth, Steam, sidebar, library overlays
- Chat state, `runTurn`, `persistChat`, variant navigation
- Game setup, cover upload, guide ingest UI
- Composer, message rendering, spoilers, examples

Every chat persistence fix touches this file. That is a merge-conflict and regression
magnet for daily-driver use.

## Goal

Split by **vertical slice** without changing behaviour. Persistence moves first;
UI shells follow.

## Target modules

| Module | Responsibility |
|--------|----------------|
| `lib/chat-messages.js` | Done | `coerceMessages`, `snapshotAssistantVariants`, `pollRecoveredMessages` |
| `lib/chat-thread.js` + `lib/chat-thread-persist.js` | Done | Normalized load/save |
| `lib/chat-message-ui.js` | Done | Source labels, highlight grouping |
| `app/chat/types.ts` | Done | Shared `Message` type |
| `app/chat/answer-body.tsx` | Done | Markdown answer rendering |
| `app/chat/message-list.tsx` | Done | User/assistant bubbles, variant nav |
| `app/chat/composer-shell.tsx` | Done | Composer + extras wiring |
| `app/chat/use-chat-turn.ts` | Pending | `runTurn`, abort, background poll, regen |
| `app/page.tsx` | Layout orchestration only (~800–1200 lines) |

## Rules

1. **No behaviour change per PR.** Extract + re-export; same tests pass.
2. **Hooks stay in client components.** Do not extract hooks into `.ts` files.
3. **One extraction per PR** where possible (messages → thread → runTurn → list).
4. Run `npm run build` after each extraction.

## Order

1. `lib/chat-messages.js` — done
2. `lib/chat-thread` + persist — done (Phase 2–3)
3. `message-list.tsx` + `composer-shell.tsx` — done
4. `use-chat-turn.ts` — largest risk; next extraction

## Exit criteria

- `page.tsx` under 3000 lines (currently ~4300 after first UI split)
- Chat bugs fixed in `lib/chat-*` without scrolling a monolith
- No new circular imports (`page.tsx` → chat modules → `page.tsx`)
