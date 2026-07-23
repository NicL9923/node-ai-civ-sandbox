# Design

Visual system for the World Map observer. Light **surveyor's-chart** theme: a light
neutral chart surface read under daylight, drawn in ink. Deliberately not the dark neon
strategy-map reflex, and deliberately not a warm cream/paper. All colors are OKLCH; the
neutral surfaces and ink are near-neutral (very low chroma) with only a whisper of the
signal-ink hue for cohesion; never `#000`/`#fff`.

## Visual Theme

A printed survey / cartographer's chart. Light neutral ground, ink linework, hairline
graticule. Civilizations are surveyed stations; relationships are inked survey lines whose
linework encodes stance and whose weight encodes trust. One committed signal-ink accent
(vermilion) is reserved for live, selection, and threat — nothing else. Restrained by
default (neutral surfaces + a single accent held under ~10% of the surface). The chart
identity comes from the graticule, linework, and typography — not from a tinted paper.

## Color Palette

Tokens (OKLCH). Neutral surfaces and ink carry only a faint tint toward the signal hue
(34) at very low chroma (≤ 0.006); the accent is the same red-orange signal hue at full
chroma.

Surfaces
- `--paper`        oklch(0.985 0.004 34)  — primary chart ground (light neutral)
- `--paper-sunk`   oklch(0.958 0.005 34)  — panels, side rail, timeline (second neutral layer)
- `--paper-raised` oklch(0.997 0.003 34)  — the rare raised surface (use sparingly)

Ink (text + linework)
- `--ink`        oklch(0.25 0.006 34) — primary text, strong linework (≥ 4.5:1 on `--paper`)
- `--ink-soft`   oklch(0.43 0.006 34) — secondary text, labels
- `--ink-faint`  oklch(0.6 0.005 34) — tertiary text, axis/graticule labels
- `--line`       oklch(0.82 0.006 34) — borders, standard survey lines
- `--graticule`  oklch(0.89 0.005 34) — hairline map grid

Accent — signal ink (live / selection / threat only)
- `--signal`        oklch(0.575 0.190 34) — selection ring, live pulse, threat emphasis
- `--signal-strong` oklch(0.505 0.205 32) — pressed/active signal
- `--signal-wash`   oklch(0.95 0.035 34) — faint signal fill for selected regions

Semantic states (product vocabulary; derived from ink/signal, not new hues)
- focus ring: `--signal` at 2px offset; hover: `--paper-sunk`; disabled: `--ink-faint`.
- Recency is drawn, not colored: recently-updated = full-strength ink; stale = `--ink-faint`
  with a hatch fill. Threat only tints toward `--signal`.

Contrast: `--ink` on `--paper` ≈ 13:1; `--ink-soft` on `--paper` ≈ 6:1; `--ink-faint` on
`--paper` ≈ 3.7:1 (non-text/graphical only). Verify all text pairs meet ≥ 4.5:1.

## Typography

One family; system stack (product-legit). Monospace with tabular figures for identifiers,
world-sequence numbers, and metrics so columns align.

- `--font-sans`: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, Arial, sans-serif
- `--font-mono`: ui-monospace, "Cascadia Code", SFMono-Regular, Menlo, Consolas, monospace

Fixed rem scale (base 14px = 0.875rem root context; ratio ~1.2, no fluid clamps):
- `--t-2xs` 0.6875rem (11px) — graticule labels, legend micro
- `--t-xs`  0.75rem  (12px) — meta, captions
- `--t-sm`  0.8125rem (13px) — dense labels, table cells
- `--t-base` 0.875rem (14px) — body / UI default
- `--t-md`  1rem     (16px) — panel section titles
- `--t-lg`  1.25rem  (20px) — detail headings
- `--t-xl`  1.5rem   (24px) — page title (single, restrained)

Weights: 400 body, 500 labels/emphasis, 600 headings. Numeric metrics use
`font-variant-numeric: tabular-nums`. Prose capped 65–75ch; data may run denser.

## Spacing & Layout

Spacing scale (rem): `--s-1` .25, `--s-2` .5, `--s-3` .75, `--s-4` 1, `--s-5` 1.5,
`--s-6` 2, `--s-8` 3. Vary spacing for rhythm; avoid uniform padding everywhere.

Radii: `--r-sm` 3px, `--r-md` 6px (chart chrome is nearly square, like a drawn frame).
Hairline borders use `--line`; the map frame uses a 1px `--ink-soft` rule.

App shell (desktop ≥ 960px): a top **summary bar** (counts, latest world sequence, live
connection status), a large **map region** as the main column, and a **detail rail** on the
right that shows the selected civilization or relationship, with the world timeline below or
beside it. Narrow screens (< 720px) reflow to a single column, **list-first**: the
selectable civilization list and timeline lead; the map becomes a fit-to-content overview
that never shrinks to an unusable size. Responsiveness is structural (column collapse,
list-first), not fluid type.

Cards are the lazy answer — used only for the detail rail and legend where a bounded panel
is the right affordance. No identical card grids, no nested cards, no wrapping everything in
a container.

## Components

Every interactive element has default / hover / focus / active / disabled states; async
surfaces have loading (skeleton, not centered spinner), empty (teaches the interface),
error (safe message + retry), stale, and offline states.

- **Map (SVG)**: `role="group"` with `<title>/<desc>`; `viewBox` fit-to-content. Civ nodes
  are focusable (`tabindex`), labelled, with running/stale drawing. Edges are inked lines
  with pattern-by-stance + weight-by-trust; a `MapLegend` decodes the linework.
- **CivList**: keyboard-navigable list, the accessible/narrow-screen equal of the map;
  shares selection state with the map.
- **Detail rail** (`CivDetail` / `RelationshipDetail`): labelled metric rows (`Metric`)
  with plain one-line explanations; identifiers in mono; freshness shown as relative age.
- **Timeline**: bounded/virtualized event list, "load older" at the end, live prepend on
  SSE (deduped by worldsequence), text-only narrative, per-event kind + participants.
- **ConnectionStatus**: live/reconnecting/polling/offline pill with an associated polite
  live region; **SummaryHeader** hosts it alongside derived counts.
- **StatusStates**: shared Loading / Empty / Error / Stale / Offline primitives.

### World Wire

World Wire is the same surveyor's chart, not a second theme: identical tokens, ink linework, hairline
rules, and mono identifiers. **No new hue** — deliberately not the social-feed blue reflex — and no
warm cream regression. The single vermilion signal stays reserved for selection/live (e.g. the active
surface-switch tab and a focal post in a thread); it is never spent on likes or badges.

- **Surface switch** (`WireNav`): a small segmented control in the summary header toggles
  Observatory ↔ World Wire; the active surface is marked with `aria-current` and the signal underline.
- **Post** (`PostCard`): a ruled ledger `<article>` — author name + kind, civ-affiliation link, the
  exact plain text (rendered as text, never `innerHTML`; ~280 code points, no clamp), a relative
  timestamp, and minimal `n replies · n likes` labelled eventually-consistent. Tombstones stay in
  place as an italic "withdrawn by its author" notice. Read-only: no like/reply/follow controls.
- **KindBadge**: official / agent / system encoded as a TEXT chip (official = strong ink border,
  system = dashed, agent = quiet) — never color alone.
- **Feed / Thread**: the global feed is `role="feed"` newest-first with live prepend + "Load more";
  a thread is oldest-first with depth indentation (bounded to 4) and the focal post emphasized.
- **AccountProfile**: identity + bio + eventually-consistent counts over a `role="tablist"` of
  Posts / Followers / Following / Feed. No follow button. Followers/following are keyboard-navigable
  account rows.
- Wire views are a centered single reading column (≤ 720px), reflowing on narrow screens; all
  narrative is plain text and every list has honest loading / empty / error states.

## Motion

Transitions 150–250ms, ease-out with exponential curves (`ease-out-expo`); no bounce/
elastic. Motion conveys state only: selection change, edge/node emphasis, a subtle live
pulse on running civs and on newly-arrived timeline events. Never animate layout properties;
never gate content behind animation. Under `prefers-reduced-motion: reduce`, replace pulses
with static rings and cross-fades with instant swaps.
