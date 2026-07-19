# GameGuide Go — UI theme

Reference for agents and contributors. Tokens live in `app/globals.css` (`:root` and
`[data-theme="dark"]`).

## Shape

**No rounded corners.** The product uses a sharp, editorial layout:

- `border-radius: 0` on cards, panels, buttons, inputs, tags, and progress bars.
- Status markers are **square dots**, not circles.
- Loaders/spinners may stay circular (functional affordance).
- Avatar images may stay circular when sourced from OAuth/Steam.

Do not introduce `rounded-*`, `border-radius`, or pill-shaped chips unless the
user explicitly changes this rule.

## Color

| Token | Role |
|-------|------|
| `--paper` / `--paper-strong` | Page and card backgrounds |
| `--ink` | Primary text, strong borders (1.5px on cards) |
| `--muted` / `--text-subtle` | Secondary text, meta labels |
| `--line` | Default 1px borders |
| `--signal` (`#00ffaa`) | Brand accent, progress, primary CTA hover |
| `--signal-dark` | Accent text on light surfaces, link color |
| `--on-signal` | Text on `--signal` fills |
| `--danger` | Errors, pending-index warnings |

Prefer existing CSS variables over hard-coded hex. Dark mode overrides the same
tokens via `[data-theme="dark"]`.

## Typography

- **Font:** Rubik (`--font-sans`), loaded in `app/layout.tsx`.
- **Meta / labels:** small caps feel — `font-weight: 700`, `letter-spacing: 0.04–0.08em`,
  `text-transform: uppercase` on buttons and platform/year lines.
- **Body:** normal case, relaxed line-height for readable answers.

## Components

- **Cards** (`.game-card`, setup panels): `border: 1.5px solid var(--ink)`,
  `background: var(--paper-strong)`, no radius.
- **Buttons:** square, bordered; hover often fills `--signal`.
- **GameFAQs bundle panel** (`.bundle-index-panel`): grouped with its guide link in
  `.game-card-guide-stack` (full card width); spoiler toggle sits below all guides
  in `.game-card-spoiler`.
- **Links:** `--signal-dark` with external-link icon pattern (`.icon-inline`).

## Copy

See **Copywriting** in `CLAUDE.md` (buddy tone, no em-dash AI tells).

## PWA / brand assets

Logo `#00FFAA` background, maskable icon padded square. Details in `CLAUDE.md`
(PWA + brand section).
