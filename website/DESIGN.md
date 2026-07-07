# DESIGN.md

Standards-document system: a **two-ink print job**. Black and red on white,
like an RFC, an ISO spec, or an engineering datasheet.

## Tokens (`src/styles/global.css`)

| Token          | Value     | Role                                                                                                        |
| -------------- | --------- | ----------------------------------------------------------------------------------------------------------- |
| `--paper`      | `#ffffff` | Body background. True white; never cream.                                                                   |
| `--paper-deep` | `#f4f0f0` | Plates (code blocks, command). Red-tinted neutral.                                                          |
| `--ink`        | `#171112` | Text + strong rules. Near-black, red-tinted.                                                                |
| `--ink-soft`   | `#5d5254` | Secondary text. ≥4.5:1 on paper.                                                                            |
| `--rule-faint` | `#ddd4d5` | Hairline rules, plate borders.                                                                              |
| `--signal`     | `#c8102e` | Red ink. Functional annotation only — § numbers, citations, prompts, labels. Never decoration, never fills. |

Neutrals carry ~0.005 chroma toward the red hue (impeccable: tint toward the
brand's own hue). Paper stays chroma-0 white.

## Type

System fonts only, zero webfonts — generated pages always ship Google Fonts;
standards documents use what the system has.

- `--sans` Helvetica Neue / Arial: prose, headings (700, ≤ -0.025em).
- `--mono` platform monospace: machinery — labels, tables, code, § numbers.

## Structural grammar

- **§ numbered sections** with gutter column. The numbers are _citations_, not
  eyebrows: every section is an `id="sNN"` anchor, § numbers self-link, and
  cross-references cite them (`→ §04 · ten minutes to a working mesh`).
- Hairline rules and double rules for hierarchy; no cards, no shadows.
- Fig. 1 shows both ingress doors (Slack and the broker's own terminal)
  joining a bus into the broker. Worker cards carry PhyloPic silhouettes
  (CC0: Kai Caspar, Beth Reinke, Margot Michaud) — taxonomy-figure register,
  solid ink, sized to roughly equal visual mass, credited in the figcaption.
- Full borders only. **No side-stripe `border-left` accents** (impeccable ban).
- One animation: the message pip travelling fig. 1's wires. It draws the actual
  data path. `prefers-reduced-motion` disables it. Nothing else moves.

## Refusals (hold the line)

1. No dark-SaaS surface (10/11 of the unslop corpus).
2. No cream/serif "AI editorial" surface (the second-order default; two early
   drafts landed there — see `design/unslop-profile.md`).
3. No webfonts, no gradient, no glow, no glass, no icon-tile grids, no sticky
   blur nav, no two-button hero.
4. Red stays functional. If red starts appearing as fills or moods, it has
   become a brand accent and the system is drifting.

## Checks

- `node <impeccable>/scripts/detect.mjs dist/**/index.html` — waivers for
  `numbered-section-markers` / `single-font` are inline in `Base.astro` with
  reasons.
- Body text ≥4.5:1; display tracking ≥ -0.04em; hero clamp ≤ 6rem.
