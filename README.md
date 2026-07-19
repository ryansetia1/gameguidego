# GameGuide Go

A mobile-first, installable (PWA) game companion. An AI model on Replicate
(default `google/gemini-2.5-flash`) answers from its own knowledge, and Tavily
web search provides supporting evidence. The interface is English, but the model
answers in whatever language you ask your question in.

## Features

### Core chat

- Game-name field with autocomplete + box art from TheGamesDB, and a
  fuzzy, acronym-aware platform selector (a searchable custom combobox: type
  `n64`, `nds`, `psx`, `ps1`, `ps2`, `gba`, `xsx`, ... and it resolves the
  right console). Covers NES through Switch 2, PS5, Xbox Series, PC, and more.
- Multi-turn follow-up chat: up to the last 5 exchanges are sent as context, so
  follow-ups like "and after that boss?" are understood.
- **Edit & retry**: edit a user message (truncates later turns and regenerates)
  or retry an assistant reply with the same question.
- **Stop**: while a turn runs, Send becomes Stop and cancels the in-flight
  request (model + web search).
- **Highlights**: assistant replies can include grouped, expandable callouts for
  key items, recruits, side quests, tips, and warnings alongside the main answer.
- **Major spoiler reveals**: when spoilers are allowed (global or per-game),
  collapsible spoiler blocks appear below the answer.
- Collapsible, sourced answers; a dismissable examples strip (remembered per
  browser); and auto-scroll to the newest reply.

### Game context

- **Game card + cover art**: once a chat starts, the input fields collapse into a
  compact card (box art + game + platform · year); a sticky mini-header appears as
  you scroll. Picking a game from autocomplete also auto-fills its box art, year,
  and platform. Cover art is signed-in only; upload your own from your device (it
  uploads only when you send, so nothing is stored for abandoned drafts) and it
  falls back to a letter tile. Edit game details from the **⋮** menu on the game
  card, sidebar, or library.
- **HowLongToBeat playtime** on the game card and sticky header (e.g. `27h main
  story`); any platform, optional Steam `appId` when the cover is a Steam CDN URL.
- Optional **preferred guide**: paste a trusted walkthrough URL or use the
  **Search web** tab to pick one. With a preferred URL the cascade is: (1) for a
  deep chapter URL, extract the matching section from that page, else (2)
  site-search the host for the right section page, else (3) site-search snippets,
  else (4) for hub/root URLs extract the pasted URL, else (5) fall back to the
  normal tiered search. When a preferred source works, the Sources list shows only
  that site.

### Saving & library (no login wall)

- **Signed-out users keep full Q&A access.** Chats are saved on-device in
  `localStorage` (`gg:local-games`, cap 20): sidebar **Your games**, **Jump back
  in** carousel on home, and a **Saved library** grid. In-progress threads also
  restore from a `sessionStorage` draft on refresh.
- **Signed-in users** sync chats to Supabase (one row per game), open saved
  threads via `?chat=<id>`, and get cover uploads, image attachments, and
  cross-device theme/spoiler/voice prefs. Changing the game name mid-session
  auto-starts a new saved chat; use **+ New game**, sidebar, or library to
  resume/delete.
- **Temporary chat** (all users): incognito mode from the composer **+** menu or
  quick-access buttons on the game card / sticky header. Starts a fresh in-memory
  thread for the same game without writing to storage; dashed composer border +
  incognito glyph signal it is on. Turning it off restores the prior saved thread
  (non-destructive); refresh wipes the temporary thread.

### Accounts & profile

- Sign in with **email/password**, **Google**, or **Continue with Steam** (needs
  `SUPABASE_SERVICE_ROLE_KEY` on the server).
- **`/profile`**: display name (used in first-turn replies), avatar picker
  (Google / Steam / upload), and voice language.
- Profile menu: global spoiler toggle, theme (**System** / **Light** / **Dark**),
  sign out.

### Steam

- **Connect Steam** (signed-in) links your library to a Google/email account.
- **Steam library** overlay: owned games with search, sort (recently played, most
  played, name, release year), and stale-while-revalidate cache. Pick a game to
  open/resume a PC chat with Steam cover art and release year.
- If a SteamID already backs a Steam-login account, the link flow offers **Use
  your Steam account** to switch into it.

### Media & voice

- **Image & camera attachments** (signed-in): attach screenshots or snap a photo
  from the composer **+** menu; images are compressed in-browser, stored in
  Supabase, and sent to Gemini as visual context.
- **Voice input** (all users): dictation via the browser Web Speech API from the
  **+** menu. Language is chosen on first use and saved per-device (and to your
  account when signed in). Text is buffered while you speak and inserted when you
  tap stop — not live. See [`docs/voice-input.md`](docs/voice-input.md).

### Spoilers

- **Global** major-spoiler toggle in the profile menu (syncs to account when
  signed in).
- **Per-game** toggle in setup **Spoilers** opt-tab and on the game card. Either
  global or per-game ON enables major spoiler sections for that turn.

### Search quality (server-side)

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

### PWA & mobile

- Installable PWA with branded icons and iOS splash screens.
- Signed-in **edge-swipe**: left opens the sidebar, right opens the last library
  (Steam when connected, else saved).
- Network-first service worker; docked composer and touch-first overlays.

## Running the app

Requirements: Node.js 20.9 or newer.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Fill `.env.local` with real credentials (see [`.env.example`](.env.example) for the
full list):

```dotenv
TAVILY_API_KEY=tvly-...
SERPER_API_KEY=...
REPLICATE_API_TOKEN=r8_...
REPLICATE_MODEL=google/gemini-2.5-flash
THEGAMESDB_API_KEY=...
STEAM_API_KEY=...
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_...
SUPABASE_SERVICE_ROLE_KEY=...
```

Only `REPLICATE_API_TOKEN` is required. Everything else is optional; each feature
degrades gracefully when its variables are absent:

| Variable | Enables |
|----------|---------|
| `TAVILY_API_KEY` | Supporting web search |
| `SERPER_API_KEY` | Search fallback when Tavily is down/over quota |
| `THEGAMESDB_API_KEY` | Game autocomplete + box art |
| `STEAM_API_KEY` | Steam library, persona on Sign in with Steam |
| `SUPABASE_SERVICE_ROLE_KEY` | **Sign in with Steam** (account bridge) |
| `AUTH_SECRET` | Steam session cookie signing (falls back to `STEAM_API_KEY`) |
| Supabase pair | Cloud saved chats, accounts, search cache, Storage |

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
- **HLTB playtime cache**: run [`db/hltb-cache.sql`](db/hltb-cache.sql) once to
  enable the shared HowLongToBeat cache for the game card. Without it, playtime
  still works but every miss re-hits HLTB upstream.
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

### Steam

Set `STEAM_API_KEY` for owned-games import and Steam persona on login. Set
`SUPABASE_SERVICE_ROLE_KEY` to enable **Sign in with Steam** (without it, Steam
stays a link-only action on an existing Google/email account). The user's Steam
profile **Game details** must be Public.

See [`docs/troubleshooting.md`](docs/troubleshooting.md) if Connect Steam OpenID
succeeds but the account does not link.

Open [http://localhost:3000](http://localhost:3000), enter a game and platform,
then ask your question and follow up.

### Troubleshooting

See [`docs/troubleshooting.md`](docs/troubleshooting.md) for recurring issues
(e.g. Connect Steam OpenID succeeding but the account not linking).

Agent / implementation docs:

- [`docs/ui-theme.md`](docs/ui-theme.md) — design tokens, no rounded corners, layout rules.
- [`docs/voice-input.md`](docs/voice-input.md) — Web Speech mic, buffer-until-stop,
  platform quirks, and what not to re-introduce.

## Flow

1. The browser sends `{ game, platform, question, history, preferredUrl,
   spoilerPrefs, playerName }` to `POST /api/solve`.
2. The route rewrites the question into a standalone English search query (via
   the LLM) so first messages are normalised/translated and follow-ups resolve
   context ("point 3").
3. It checks the Supabase search cache; on a miss it runs the search (preferred
   cascade or normal tiers), cleans snippets, filters by relevance score, keeps
   the 3 strongest sources, and caches the result.
4. `system_instruction` (persona + rules + JSON output contract) and `prompt`
   (game/platform, history, web evidence) are sent separately to the Gemini model
   on Replicate. The response is parsed into `{ answer, highlights, spoilers,
   spoilerRisk }`. When spoilers are OFF and `spoilerRisk` is set, a second
   censor pass may rewrite the answer.
5. The browser renders the answer, optional highlights/spoiler blocks, and
   sources; it saves the whole chat to Supabase (signed-in) or `localStorage`
   (anon) unless temporary chat is on.

Provider secrets stay on the server and are never sent to the browser. Source
text and game/platform input are treated as untrusted; the model is instructed
not to follow instructions embedded in them.

## Commands

- `npm run dev` — development server
- `npm run build` — production build
- `npm start` — run the production build
- `npm run check` — small self-check for the prompt builder, snippet cleaner,
  source selection, IGDB mapping, platform matching, and highlight parsing
