# Unslop profile: developer tool landing pages (open-source infrastructure)

Generated from 11 HTML samples + screenshots (see `analysis.md` for counts).
Mostly "what to avoid". Counts cite the sample batch.

---

## Structure to avoid

- Do not use the universal skeleton: header nav → centered hero (eyebrow pill + H1 + subhead + two buttons) → feature-card grids → comparison table → closing CTA band → footer (11/11).
- Do not stack the hero as: rounded-full eyebrow pill with pulsing dot → 2-line bold tracking-tight H1 → muted centered subhead → exactly two CTA buttons, one solid + one ghost (10/11).
- Do not put a small colored-dot "announcement pill" above the headline (7/11).
- Do not default to icon-tile + bold heading + gray description feature cards in a 2/3-column grid (9/11).
- Do not use a sticky backdrop-blur header (6/11).
- Do not end with the footer formula: copyright left, `GitHub · Docs · Discord` link row right (10/11).

## Visual defaults to avoid

- Do not default to a near-black background (10/11) — and if you go light instead, know that warm-cream + ember accent is *also* a stock move (the one light sample used exactly that).
- Do not pick your accent from the green/teal or orange/amber families — 11/11 samples landed in just those two (plus one acid-lime). Blue, purple, magenta went entirely unused.
- Do not put a blurred radial glow blob behind the hero (9/11).
- Do not add faint grid-line or dot textures behind sections (6/11).
- Do not use the translucent "glass card" recipe (`rgba(255,255,255,0.03)` fill + `0.06–0.09` border) (6/11).
- Do not dress code blocks in macOS window chrome with red/yellow/green dots (8/11) — and avoid the residual form too: a dark terminal-styled box dropped into a light page.
- Do not highlight one clause of the H1 in the accent color (9/11).

## Typography to avoid

- Do not default to Inter + JetBrains/Plex Mono as the pairing (8/11).
- Do not set the whole page in monospace to signal "terminal/infra" (3/11, always fused with green accents).
- Do not lean on uppercase letter-spaced micro-labels as your only labeling idea (near-universal).

## Code-level tells to avoid

- No Tailwind Play CDN `<script>` pasted reflexively (10/11), especially if you then hand-roll all the CSS anyway.
- No `preconnect` to Google Fonts as boilerplate (11/11) — self-host or subset deliberately.
- No copy-button JS that swaps to "Copied!" and reverts after ~1500ms (4/11, near-identical code).
- No blinking-caret `@keyframes blink` flourish (3/11).

## Copy to avoid

- Do not build the headline on negative contrast: "X without the Y pain", "not a platform team", "That's the problem." (6/11).
- Do not use triadic negation rhythm: "no X, no Y, no Z" (5/11).
- Do not center the pitch on "a single binary" (7/11 — across task runners, queues, vector DBs, meshes alike).
- Do not stage a "we're honest about our flaws" section or a comparison table that concedes one row on purpose as a credibility trick (4–5/11).
- Ration em dashes: every sample used em-dash asides, up to 17 per page. A few are fine; a rhythm of them is a tell.
- Do not ship placeholder social proof (`[Customer Name]`) — if there is no proof, cut the section.

---

## The second-order attractor (learned the hard way)

Dodging the counted patterns above is not enough. When told to avoid them,
models fall into a *second* default: the "tasteful AI editorial" surface —
warm cream background, literary serif, one refined accent (terracotta or
International Klein blue). That is Anthropic's own house style, and it is now
as recognizable as the dark-SaaS template. Two early drafts of this site
landed in it (cream + ember, then cream + ultramarine) while passing every
counted check.

The escape is not another palette swap. Ask what the *authentic human-made
artifacts* in the content's domain look like (for infrastructure: RFCs, ISO
specs, datasheets, DIN manuals) and take the surface from there:

- White, not cream. Warmth is an affectation the content did not ask for.
- Grotesque or Times, not a literary serif.
- System fonts, no webfonts — generated pages virtually always ship Google
  Fonts because that is what a CDN import can reach.
- Color as functional annotation (two-ink print logic), not as brand accent.

---

If a choice matches one of these counted defaults — or the second-order
default — stop and make a different one. The goal is not a new template; it
is refusing the old one, including the one the model itself prefers.
