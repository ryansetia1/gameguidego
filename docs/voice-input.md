# Voice input (Web Speech API)

Agent-oriented notes for the composer mic feature. Read this before changing
`app/voice-input.tsx`, `lib/voice.js`, or `lib/voice-meter.js`.

**Status:** interim / stable-enough prototype. Free browser STT only — no server
transcription. Behaviour was tuned through several iterations; the current design
intentionally keeps recognition simple and buffers text until the user presses stop.

## User-facing behaviour

1. User taps **mic** (or **Voice input** inside the mobile **+** menu).
2. First use with no saved language → language picker (`VOICE_LANGUAGES` in
   `lib/voice.js`). After that, tap starts listening immediately.
3. While listening: mic shows **stop** icon + CSS pulse; decorative sound bars
   (`VoiceVisualizer`) overlay the composer textarea. **The textarea does not
   update live.**
4. User taps **stop** → buffered transcript is appended to the composer once
   (joined with a space if the field already has text).
5. Mic permission is requested only on click (`recognition.start()`), never on
   page load.
6. Button is hidden when `getSpeechRecognition()` is null (e.g. Firefox).

Composer is locked (`composerLocked`) until a game name is set — mic/attach/send
are disabled together.

## File map

| File | Role |
|------|------|
| `app/voice-input.tsx` | `useVoiceInput` hook + `VoiceInput` mic button |
| `app/composer-extras.tsx` | Mobile **+** menu; reuses `useVoiceInput` |
| `app/voice-visualizer.tsx` | CSS-only animated bars while listening |
| `lib/voice.js` | Language list/prefs, `getSpeechRecognition`, platform helpers |
| `lib/voice-meter.js` | `warmUpMicrophone()` only — no live analyser |
| `app/page.tsx` | Wires mic, visualizer, `onTranscript` → `setInput`, `voiceListening` |

Language persistence:

- Device: `localStorage` key `gg:voice-lang`
- Signed-in: `user_metadata.voice_lang` (also editable on `/profile`)

## UI layout (`app/page.tsx`)

- **Desktop / signed-out / no speech API:** separate attach (signed-in) + mic +
  send.
- **Mobile (≤540px) + signed-in + speech supported:** `ComposerExtras` replaces
  attach + mic with one **+** button (photo / camera / voice). `showCombinedExtras`
  controls this.

`onTranscript` in both paths:

```ts
setInput((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text))
```

## Core design decisions (do not regress lightly)

### 1. Buffer until stop

Transcript must **not** stream into the composer during recognition. All capture
logic writes to internal refs; `onTranscript` runs once in `flushBuffer()` when
the user stops (or tab backgrounds — see lifecycle below).

**Why:** Live append + `continuous` mode + iOS restarts produced duplicated,
truncated, and overlapping text. Buffer-until-stop is the intended product behaviour.

### 2. Final-only recognition (`interimResults: false`)

Matches the stable `e469d89` path. Do not enable interim results without re-testing
on iOS Safari — it was a major source of garbage text and duplicate fragments.

### 3. Platform-split capture strategy

`prefersChunkedSpeechRecognition()` in `lib/voice.js` returns true for iPhone/iPad/
iPod and iPadOS desktop UA (`MacIntel` + `maxTouchPoints > 1`).

| Platform | `continuous` | Capture in `onresult` | Multi-phrase sessions |
|----------|--------------|----------------------|------------------------|
| Desktop (Chrome, etc.) | `true` | Rebuild **one string** from all `isFinal` entries in `event.results` (replace buffer, do not append per event) | Single `SpeechRecognition` instance until stop |
| iOS / iPadOS | `false` | Read **only** `event.results[0][0].transcript` per cycle | Auto-restart after `onend` (+ `SPEECH_RESTART_MS` delay) while `listeningRef` is true; phrases stored in `partsRef`, joined on flush |

**Critical:** Never iterate all `event.results` indices on iOS with append semantics —
cumulative results cause repeated substrings. Never append desktop finals one-by-one —
use full rebuild each `onresult`.

### 4. Fresh `SpeechRecognition` instance per cycle

Each `beginListening()` does `new SpeechRecognition()`. No singleton reuse across
restarts (older singleton + `abort()` races caused stop/restart bugs).

### 5. `stop()` uses `recognition.stop()`, not `abort()`

`stop()` lets the engine emit a final `onresult` before `onend`. `abort()` drops
pending finals — only use `abort()` on unmount, superseded start, or stop fallback.

Stop flow:

1. `listeningRef.current = false` (prevents iOS auto-restart)
2. `recognition.stop()`
3. `onend` → `flushBuffer()` → `onTranscript` once
4. Fallback timer (750 ms): if `onend` never fires, flush + `abort()` anyway

### 6. No concurrent `getUserMedia` while recognizing

`SpeechRecognition` must own the mic alone. A second `getUserMedia` stream (e.g.
for live volume meters) **blocks transcription** on desktop and mobile.

- **Allowed:** `warmUpMicrophone()` — acquire + immediate `track.stop()` before
  the first `recognition.start()` in a session.
- **Allowed:** `VoiceVisualizer` — pure CSS animation, no audio API.
- **Not allowed:** `AnalyserNode` / held `getUserMedia` during listening.

Upgrade path for real levels: MediaRecorder + server STT, or a different STT SDK —
not a parallel browser mic stream.

## Lifecycle diagram

```
tap mic
  → clearBuffer()
  → listeningRef = true
  → warmUpMicrophone() (first cycle only)
  → new SpeechRecognition()
  → recognition.start()
  → onresult: update bufferRef (desktop) or partsRef (iOS)
  → [iOS only] onend while listeningRef → delayed restart → new instance
tap stop
  → listeningRef = false
  → recognition.stop()
  → onend → flushBuffer() → onTranscript(text) → composer updated once
```

Auto-stop triggers (all call the same `stop()` path):

- `disabled` becomes true (e.g. composer locked mid-dictation)
- `document.visibilityState === "hidden"` (tab switch / app background)

## Hook API (`useVoiceInput`)

Exported for `VoiceInput` and `ComposerExtras`:

```ts
useVoiceInput({
  user,           // syncs voice_lang from metadata when signed in
  disabled,       // blocks start; stops active session
  onTranscript,   // called once per stop with full buffered string
  onListeningChange?, // drives VoiceVisualizer + empty placeholder
})
```

Returns: `{ supported, lang, listening, pickerOpen, setPickerOpen, start, stop,
handleClick, pickLanguage }`.

## `lib/voice.js` exports

| Export | Purpose |
|--------|---------|
| `VOICE_LANGUAGES` | Picker list (extend here for more locales) |
| `loadVoiceLang` / `saveVoiceLang` | localStorage read/write |
| `voiceLangFromUserMetadata` | Account sync |
| `getSpeechRecognition()` | Feature detect (`SpeechRecognition` \|\| `webkitSpeechRecognition`) |
| `prefersChunkedSpeechRecognition()` | iOS/iPadOS split |
| `SPEECH_RESTART_MS` (250) | Delay before iOS restart |
| `mergeSpeechParts()` | Dedupes consecutive equal strings (used in `npm run check`; iOS join is currently `parts.join(" ")`) |
| `shouldRetrySpeechError` / `isBenignSpeechError` | Legacy helpers; **not wired** in current `voice-input.tsx` (errors just end the session) |

## Known limits (ponytail)

- **Browser support:** Chromium + Safari/WebKit only. No Firefox. Quality varies by
  OS/browser; Indonesian (`id-ID`) depends on the engine, not our code.
- **No live preview:** User cannot see partial transcript while speaking — by design.
- **iOS phrase boundaries:** `continuous: false` ends each phrase on pause; restarts
  may occasionally split or overlap across cycles on long utterances.
- **Desktop single session:** `continuous: true` should run until stop; if the OS
  ends recognition early, there is no desktop auto-restart (only iOS restarts).
- **Error handling is minimal:** `onerror` clears listening state without flushing
  partial buffer or surfacing UI errors.
- **Stop during `warmUpMicrophone()`:** If user stops before warm-up completes,
  `beginListening` bails when `listeningRef` is false — safe, no leak.
- **Language ≠ answer language:** Voice lang sets STT locale only; the LLM still
  answers in the player's question language per `SYSTEM_INSTRUCTION`.

## What we tried and rejected

Documented so future agents do not re-introduce these:

| Approach | Problem |
|----------|---------|
| Live append on each `onresult` | Duplicated text when left recording; filled textarea |
| `interimResults: true` + interim flush | Overlap with finals; messy stop behaviour |
| Singleton `SpeechRecognition` + `abort()` on stop | Lost finals; stop needed double-tap |
| `getUserMedia` + `AnalyserNode` during recognition | Recognition stopped working entirely |
| Appending every index in `event.results` | Cumulative Web Speech list → repeat/truncate loops |
| Complex session IDs + network retry loops | Hard to reason about; replaced by simpler e469d89 base |

Stable reference commit for recognition settings only (not buffer UX):
`e469d89bbdac08c9f658f02b77eb864aaf322d28`.

## Safe change checklist

Before merging voice changes:

1. Test **start → speak → stop** — composer gets one clean string.
2. Test **long recording without stop** (desktop) — no live textarea updates; stop
   still produces one append.
3. Test on **iOS Safari** if available — multi-phrase dictation + stop.
4. Confirm mic still works after visualizer/CSS changes (no `getUserMedia` hold).
5. Run `npm run check` (`coerceVoiceLang`, `mergeSpeechParts`, etc.).

## Planned upgrades (not implemented)

- Live interim preview in a **separate** non-composer UI (not streaming into the
  send field).
- Server-side STT for consistent quality and real audio meters.
- Richer error toasts (`not-allowed`, `network`, `no-speech`).
- Wire `shouldRetrySpeechError` again if network flakes need auto-retry without
  duplicating text.
