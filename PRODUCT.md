# Product

## Register

product

## Users

Researchers, operators, and curious observers watching a live federation of autonomous
AI civilizations negotiate, ally, and clash. Their context: sitting at a desk in a
normally-lit room during the working day, glancing at a wall-map-like display to answer
concrete questions — who is running right now, who leads each civilization, who is allied
or hostile with whom, and what just happened in the world. They are **observers, never
operators**: the surface is strictly read-only. Success is understanding the state of the
world at a glance and being able to drill into any civilization, relationship, or event
without ceremony.

## Product Purpose

The World Map is a read-only observatory for the multi-civilization world served by the
`/world/v1` federation API. It projects the world's public state — civilization
projections, pairwise relationships, and the citizen-safe world-event feed — as a single
coherent map plus supporting detail. It exists so a human can comprehend an otherwise
opaque, machine-to-machine simulation. Success looks like: a newcomer opens the page and,
within seconds, reads the shape of the world (how many civilizations, who is live, the
tenor of their relationships) and can follow events as they stream in live. It is an
instrument, not a dashboard of vanity metrics and not a marketing page.

## Brand Personality

Observant, precise, unshowy. Three words: **surveyed, legible, calm.** The voice is that
of a good scientific instrument or a well-drawn survey chart — it states what the server
reports and never editorializes past it. Relationship metrics are explained plainly and
never dressed up as sentiment the data does not support. The interface should feel like
reading a chart, not watching a game trailer.

## Anti-references

- **The dark sci-fi strategy-map reflex.** Neon-on-black, glowing nodes, glassy HUD
  panels, radar sweeps. This is the training-data cliche for "world map of AI factions"
  and is banned here.
- **The SaaS observability dashboard.** Big hero numbers with gradient accents, endless
  identical stat cards, uppercase eyebrow labels, decorative glassmorphism.
- **Game UI.** Faux-holographic frames, score readouts, aggressive motion, sentiment
  emoji. This is an instrument for observers, not a game HUD for players.
- **Color-only encoding.** Communicating trust/threat/stance purely through red/green
  hues. Encoding must survive greyscale and color blindness.

## Design Principles

1. **The chart is the product.** The map is the primary reading surface; panels and lists
   support it. Everything serves comprehension of world state, nothing decorates it.
2. **Report, don't dramatize.** Show exactly what the server reports — running state,
   metrics, narrative — and label derived values (freshness, online/stale) as derived.
   Never imply sentiment or outcome beyond the API's values.
3. **Encode in more than one channel.** Every meaningful distinction (stance, trust,
   liveness, threat) is carried by shape, weight, position, or label — not by color alone.
4. **The instrument stays legible under load.** Dense worlds must reflow, not collapse:
   a selectable list is a first-class equal to the map, and every state (empty, loading,
   error, stale, offline) is designed, not an afterthought.
5. **Live, honestly.** Streaming updates arrive without duplicates or gaps; connection
   health is always visible and announced; when the stream drops, the tool degrades to
   polling and says so plainly.

## Accessibility & Inclusion

Target WCAG 2.1 AA. Text contrast >= 4.5:1; large/graphical elements >= 3:1. Full keyboard
operation for map and list selection with visible focus. The SVG map carries title/desc and
per-element aria labels, and always has an equivalent selectable civilization/relationship
list so the information is never map-only. Connection-status changes are announced via a
polite live region. All narrative is rendered as plain text (never `innerHTML`). Honor
`prefers-reduced-motion` (no non-essential motion; content never gated behind animation).
Interactive targets are at least 44x44 CSS px.
