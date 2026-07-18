# GameGuide Guru

A mobile-first, installable (PWA) game companion. An AI model on Replicate
(default `google/gemini-2.5-flash`) answers from its own knowledge, and Tavily
web search provides supporting evidence. The interface is English, but the model
answers in whatever language you ask your question in.

## Features

- Game-name field with autocomplete + box art from TheGamesDB, and a
  fuzzy, acronym-aware platform selector (a searchable custom combobox: type
  `n64`, `nds`, `psx`, `ps1`, `ps2`, `gba`, `xsx`, ... and it resolves the
  right console). Covers NES through Switch 2, PS5, Xbox Series, PC, and more.
- **Game card + cover art**: once a chat starts, the input fields collapse into a
  compact card (box art + game + platform); a sticky mini-header appears as you
  scroll. Picking a game from autocomplete also auto-fills its box art, year, and
  platform. Cover art is signed-in only; upload your own from your device (it
  uploads only when you send, so nothing is stored for abandoned drafts) and it
  falls back to a letter tile. Edit game details from the **⋮** menu in the sidebar.
- Optional **preferred guide link**: paste the guide you trust and search sources
  from it first. The cascade is: (1) site-search the host for your question and
  extract the best-matching section page, else (2) use site-search snippets, else
  (3) pull the exact pasted URL, else (4) fall back to the normal tiered search.
  When a preferred source works, the Sources list shows only that site.
- **Accounts (optional, no login wall)**: sign in with email/password or Google
  (via Supabase) to save a separate chat per game and resume it later. Changing
  the game name mid-session auto-starts a new saved chat; you can also use
  **+ New game**, open past games from **Your games**, or delete finished ones.
  Signed-out visitors keep full access; they just cannot save.
- **Edit & retry**: edit a user message (truncates later turns and regenerates)
  or retry an assistant reply with the same question.
- **Highlights**: assistant replies can include grouped, expandable callouts for
  key items, recruits, side quests, tips, and warnings alongside the main answer.
- **Image & camera attachments** (signed-in): attach screenshots or snap a photo
  next to the send button; images are compressed in-browser, stored in Supabase,
  and sent to Gemini as visual context. **Library**: a 2-column cover-art grid of
  your saved games. **Dark mode** follows your system preference automatically.
- **Voice input** (all users): a mic button beside Send dictates your question
  via the browser's built-in speech recognition. Pick a language the first time
  (change it later on `/profile`); it's saved per-device and, when signed in, to
  your account. The mic only asks permission when you tap it, and the button
  hides on browsers without speech support.
- Multi-turn follow-up chat: up to the last 5 exchanges are sent as context, so
  follow-ups like "and after that boss?" are understood.
- Tiered search: GameFAQs first, then trusted walkthrough providers, then forums,
  then the open web. Video/social domains (YouTube, Twitch, etc.) are excluded
  because the text model cannot read them.
- Noise filtering: Tavily `advanced` extraction, relevance-score filtering
  (drops unrelated same-series games), snippet cleaning, dedupe by title+URL, and
  only the 3 strongest sources are sent to the model.
- Confidence gate: if nothing is clearly relevant, sources are dropped and the
  model answers from its own knowledge (or says it is unsure) rather than being
  nudged by a half-relevant snippet.
- Shared web-search cache (Supabase, 7-day TTL): repeat/popular queries skip the
  Tavily calls entirely to save credits and latency.
- Collapsible, sourced answers; a dismissable examples strip (remembered per
  browser); and auto-scroll to the newest reply.

## Running the app

Requirements: Node.js 20.9 or newer.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Fill `.env.local` with real credentials:

```dotenv
TAVILY_API_KEY=tvly-...
SERPER_API_KEY=...
REPLICATE_API_TOKEN=r8_...
REPLICATE_MODEL=google/gemini-2.5-flash
THEGAMESDB_API_KEY=...
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_...
```

Only `REPLICATE_API_TOKEN` is required. `TAVILY_API_KEY` (web search),
`SERPER_API_KEY` (search fallback when Tavily is down/over quota), `REPLICATE_MODEL`,
`THEGAMESDB_API_KEY` (autocomplete + box art), and the Supabase pair (accounts +
saved chats + cache) are all optional; each feature degrades gracefully when its
variables are absent.

The model input fields (`system_instruction`, `max_output_tokens`,
`thinking_budget`) are tuned for Gemini on Replicate; only swap `REPLICATE_MODEL`
for a model with equivalent fields.

### Game-name autocomplete + box art (TheGamesDB)

Autocomplete and cover art use [TheGamesDB](https://thegamesdb.net). Request an
API key from your account and set `THEGAMESDB_API_KEY`. Without it the game field
still works as free text (autocomplete silently turns off) and covers fall back to
a letter tile. IGDB has better coverage and is the intended eventual upgrade; the
provider lives entirely in `app/api/games/route.ts` + `lib/games.js`.

### Accounts and saved chats (Supabase)

Accounts, per-game saved chats, and the shared search cache use
[Supabase](https://supabase.com). The schema (a `chats` table with row-level
security and a public `search_cache` table) is managed as a migration on the
`GameGuideGuru` project. Set `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_ANON_KEY` (the publishable key) to enable it — both are
safe to expose because access is protected by row-level security.

Manual dashboard steps in Supabase:

- **Cover metadata + uploads**: run [`db/cover-metadata.sql`](db/cover-metadata.sql)
  in the SQL editor once. It adds `cover_url`/`release_year` to `chats` and creates
  the public `covers` Storage bucket (owner-write, public-read) used by device
  cover uploads. Until it runs, saving still works but covers/year are dropped.
- **Google sign-in**: enable the Google provider under Authentication ->
  Providers, add your Google OAuth client ID/secret, and add your app origin(s)
  to the allowed redirect URLs.
- **URL configuration (required for Vercel)**: under Authentication -> URL
  Configuration, set **Site URL** to your production `*.vercel.app` URL and add
  that URL, `https://*.vercel.app` (previews), and `http://localhost:3000` to
  **Redirect URLs**. Without this, OAuth can bounce to `localhost` after sign-in
  on a deployed preview.
- **Email sign-in**: for a frictionless flow, disable "Confirm email" under
  Authentication -> Providers -> Email. If left on, new sign-ups see a
  "check your email to confirm" message before they can sign in.

Open [http://localhost:3000](http://localhost:3000), enter a game and platform,
then ask your question and follow up.

### Troubleshooting

See [`docs/troubleshooting.md`](docs/troubleshooting.md) for recurring issues
(e.g. Connect Steam OpenID succeeding but the account not linking).

## Flow

1. The browser sends `{ game, platform, question, history, preferredUrl }` to
   `POST /api/solve`.
2. The route rewrites the question into a standalone English search query (via
   the LLM) so first messages are normalised/translated and follow-ups resolve
   context ("point 3").
3. It checks the Supabase search cache; on a miss it runs the search (preferred
   cascade or normal tiers), cleans snippets, filters by relevance score, keeps
   the 3 strongest sources, and caches the result.
4. `system_instruction` (persona + rules + JSON output contract) and `prompt`
   (game/platform, history, web evidence) are sent separately to the Gemini model
   on Replicate. The response is parsed into `{ answer, highlights }`.
5. The browser renders the answer, optional highlight callouts, and sources; when
   signed in it saves the whole chat to Supabase so it can be resumed later.

Provider secrets stay on the server and are never sent to the browser. Source
text and game/platform input are treated as untrusted; the model is instructed
not to follow instructions embedded in them.

## Commands

- `npm run dev` — development server
- `npm run build` — production build
- `npm start` — run the production build
- `npm run check` — small self-check for the prompt builder, snippet cleaner,
  source selection, IGDB mapping, platform matching, and highlight parsing
