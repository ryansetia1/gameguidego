# GameGuide Guru

## Purpose

Mobile-first Next.js prototype that turns a player's game question into a
web-researched, AI-summarized walkthrough with visible source links. Supports a
game name + platform selector and multi-turn follow-up chat.

## Architecture

- `app/page.tsx`: Indonesian client chat UI (game field, platform selector,
  message feed, docked composer) and `/api/solve` consumer. Keeps `messages`
  state and sends the last 10 messages (5 turns) as `history`.
- `app/api/solve/route.ts`: validates/sanitizes `{ game, platform, question,
  history }` at the trust boundary (history capped to 10, content truncated),
  builds the search query, then orchestrates search then summary.
- `lib/tavily.ts`: Tavily Search API adapter and external-result validation.
- `lib/replicate.ts`: Replicate model adapter (`summarize(input)` object) and
  output normalization; exports the `Turn` type.
- `lib/prompt.js`: shared prompt builder `buildPrompt({ game, platform,
  question, sources, history })`, covered by `npm run check`.

## Known limits (ponytail)

- Chat history is sent as plain text inside a single prompt (not the Llama 3
  native chat template) and trimmed by turn count, not token count. Upgrade to
  the role-based template + token-aware trimming if longer sessions overflow the
  8k context window.
- Every turn re-runs a web search; there is no caching.

## Commands

```bash
npm run dev
npm run check
npm run build
```

## Environment

Required server-only variables:

- `TAVILY_API_KEY`
- `REPLICATE_API_TOKEN`

Optional: `REPLICATE_MODEL` in `owner/name` format. Never expose these through a
`NEXT_PUBLIC_` variable or commit `.env.local`.

## Working conventions

- Keep provider calls server-side.
- Validate browser input and all external API data.
- Keep the UI dependency-free and accessible.
- Preserve source links alongside every generated guide.
- Update this file when architecture, providers, commands, or environment
  requirements change significantly.
