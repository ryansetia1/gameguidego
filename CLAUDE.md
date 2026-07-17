# GameGuide Guru

## Purpose

Mobile-first Next.js prototype that answers a player's game question. The model
(Gemini 2.5 Flash on Replicate) answers from its own knowledge; tiered web search
provides supporting evidence. Supports IGDB-backed game-name autocomplete, a
searchable platform selector, and multi-turn follow-up chat.

## Architecture

- `app/page.tsx`: Indonesian client chat UI (game field, message feed, docked
  composer) and `/api/solve` consumer. Keeps `messages` state and sends the last
  10 messages (5 turns) as `history`.
- `app/platform-select.tsx`: custom themed, searchable, keyboard-accessible
  platform combobox (owns the `PLATFORMS` list). Replaces the native `<select>`.
- `app/game-autocomplete.tsx`: debounced game-name autocomplete for the game
  field; queries `/api/games`, reuses the `.combo` styling, allows free text, and
  hides itself when the DB is unavailable (`available: false`).
- `app/api/games/route.ts`: IGDB proxy. Fetches a Twitch app access token
  (cached in-memory), runs an Apicalypse `search` query, and returns
  `{ games, available }`. Missing creds or any failure => `available: false` so
  the field degrades to free text. `lib/games.js#mapGames` shapes IGDB rows.
- `app/api/solve/route.ts`: validates/sanitizes `{ game, platform, question,
  history }` at the trust boundary (history capped to 10, content truncated).
  Search is best-effort (skipped if no `TAVILY_API_KEY`, failures swallowed); the
  model still answers. Only `REPLICATE_API_TOKEN` is mandatory.
- `lib/tavily.ts`: `searchGuides(query)` runs tiered searches (GameFAQs ->
  trusted walkthrough providers -> forums -> general) with `search_depth:
  "advanced"`, excludes video/social domains, dedupes by URL+title, cleans each
  snippet via `cleanSnippet`, then hands results to `selectSources`.
- `lib/rank.js`: `selectSources(results)` applies a confidence gate (returns
  `[]` when even the best score is below `CONFIDENCE_MIN`, so the model answers
  from knowledge alone), keeps results within `SCORE_WINDOW` of the top score,
  and caps at 3. Covered by `npm run check`.
- `lib/clean.js`: `cleanSnippet(text)` strips markdown link soup, bare URLs,
  GameFAQs CTAs, and Q&A vote/user lines. Covered by `npm run check`.
- `lib/replicate.ts`: Replicate adapter (`summarize(input)`); sends
  `system_instruction` + `prompt` separately with Gemini fields
  (`max_output_tokens`, `thinking_budget: 0`). Exports the `Turn` type.
- `lib/prompt.js`: exports `SYSTEM_INSTRUCTION` (persona + rules: knowledge-first,
  web-as-support, injection safety) and `buildPrompt({ game, platform, question,
  sources, history })` (dynamic context). Covered by `npm run check`.
- `lib/games.js`: `mapGames(results)` maps raw IGDB rows to `{ id, name, year }`
  (year derived from unix `first_release_date`), dropping malformed entries.
  Covered by `npm run check`.

## Known limits (ponytail)

- Model-call input fields are Gemini-specific; switching `REPLICATE_MODEL` to a
  non-Gemini model would silently drop `system_instruction`/`thinking_budget`.
- Chat history is sent as plain text inside the prompt and trimmed by turn count,
  not token count.
- Every turn re-runs the tiered search (up to 4 sequential Tavily calls, early
  exit); there is no caching. `advanced` depth costs ~2x credits vs `basic`.
- Relevance filtering can't separate same-series wrong-game guides (RE0 vs RE
  Code: Veronica score alike); the top-3 trim plus the "ignore off-game
  snippets" system rule mitigate it rather than fully solving it.
- The `CONFIDENCE_MIN`/`SCORE_WINDOW` thresholds in `lib/rank.js` are heuristics
  calibrated on a handful of real queries, not a learned cutoff; tune them there
  if answers cite too much or fall back to knowledge too often.
- Tavily still returns arbitrary page chunks (control lists, TOCs), not the
  section that answers the question; the model leans on its own knowledge.
- Game autocomplete uses IGDB (RAWG was tried first but proved unreliable). The
  Twitch token cache is per server instance, not shared across instances.

## Commands

```bash
npm run dev
npm run check
npm run build
```

## Environment

Server-only variables:

- `REPLICATE_API_TOKEN` (required to answer).
- `TAVILY_API_KEY` (optional; enables supporting web search).
- `REPLICATE_MODEL` (optional, default `google/gemini-2.5-flash`).
- `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` (optional; enable IGDB game-name
  autocomplete).

Never expose these through a `NEXT_PUBLIC_` variable or commit `.env.local`.

## Working conventions

- Keep provider calls server-side.
- Validate browser input and all external API data.
- Keep the UI dependency-free and accessible.
- Preserve source links alongside every generated guide.
- Update this file when architecture, providers, commands, or environment
  requirements change significantly.
