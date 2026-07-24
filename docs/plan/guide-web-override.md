# Guide web retrieval toggles

**Status:** Shipped (July 2026)  
**Audience:** Future agents maintaining or removing this feature  
**Last updated:** 2026-07-25  
**Related:** `lib/guide-retrieval-mode.js`, `app/api/solve/route.ts`, `app/composer-extras.tsx`

## Purpose

When a preferred guide is attached, RAG hit skips web search by default. Players sometimes need:

1. **Search web instead** — skip the guide this turn (already know it; ask outside it).
2. **Also search web** — keep the guide primary and add web snippets (patches, meta).

Two mutually exclusive composer toggles (visible only when `preferredUrls.length > 0`).

## API (`POST /api/solve`)

| Field | Type | Effect |
|-------|------|--------|
| `skipPreferredGuide` | boolean | Skip RAG; web + knowledge only (`web_skip_guide`) |
| `alsoSearchWeb` | boolean | After RAG hit, also run web (`rag_supplemented`) |

`coerceGuideRetrievalFlags()` in `lib/guide-retrieval-mode.js`: skip wins if both sent.

Client mode → API via `guideRetrievalModeToApi("default" | "skip" | "supplement")`.

## Behavior matrix

| Mode | RAG | Web on hit | `pipelineType` |
|------|-----|------------|----------------|
| default OFF | Yes | No | `rag` |
| default OFF, miss | Yes | Yes | `fallback_web` |
| **skip** | No | Yes | `web_skip_guide` |
| **supplement** | Yes | Yes | `rag_supplemented` |

Persistence: `sessionStorage` `gg:guide-retrieval-mode`. Resets when guide removed.

## Teardown

Grep: `skipPreferredGuide`, `alsoSearchWeb`, `web_skip_guide`, `rag_supplemented`,
`guide-retrieval-mode`, `Search web instead`, `Also search web`

Remove toggles from `composer-extras.tsx`, branch in `solve/route.ts`, hints in
`guide-hints.js`, labels in `chat-message-ui.js`, `webSupplement` in `prompt.js` /
`replicate.ts`, this file.

## Decision log

| Date | Decision |
|------|----------|
| 2026-07-25 | Two toggles, mutually exclusive |
| 2026-07-25 | Skip = no RAG call (cost + intent) |
| 2026-07-25 | Supplement = combine, guide primary via prompt |
