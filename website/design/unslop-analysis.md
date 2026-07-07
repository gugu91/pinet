# Slop Analysis: Developer Tool Landing Pages (11 samples)

Samples: `sample_0000` Fenwick (task runner) · `sample_0001` Flint (message queue) · `sample_0002` Wick (edge tracing) · `sample_0003` Sylo (vector DB) · `sample_0004` Ledgerline (config mgmt/compliance) · `sample_0005` Kiln (workflow orchestration) · `sample_0006` Latchkey (feature flags) · `sample_0007` Skiff (service mesh) · `sample_0008` trace (API gateway) · `sample_0009` Forgeline (CI/CD runners) · `sample_0010` Kindling (log aggregator)

Despite genuinely different micro-themes (terminal-hacker green, enterprise-compliance navy, warm indie-cream), the batch is built from a shockingly small set of interchangeable parts. Below, every pattern is cited by sample number and counted out of 11.

---

## 1. Tech-stack boilerplate (code-level)

| Pattern                                                                                                                                                                             | Count                                                                                                                                     | Notes                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<link rel="preconnect" href="https://fonts.googleapis.com">` in `<head>`                                                                                                           | **11/11**                                                                                                                                 | Included even in `sample_0008`, which never actually loads a second font weight beyond JetBrains Mono, and even though the page is mostly static.                                                    |
| `<script src="https://cdn.tailwindcss.com"></script>` (Tailwind Play CDN, not a build step)                                                                                         | **10/11**                                                                                                                                 | Only `sample_0008` skips it, hand-rolling all CSS.                                                                                                                                                   |
| Tailwind loaded but barely used — page is styled almost entirely via a `<style>` block of bespoke classes (`.card`, `.term`, `.brand`, custom CSS vars) rather than utility classes | **2/11** (`sample_0006`, `sample_0007`)                                                                                                   | The CDN `<script>` tag is pasted reflexively as a first-line habit, then abandoned once a hand-styled aesthetic kicks in.                                                                            |
| `tailwind.config = { theme: { extend: { fontFamily, colors } } }` inline customization block                                                                                        | **5/11** (`0000`,`0001`,`0003`,`0004`,`0009`)                                                                                             | Always the same shape: `fontFamily.sans` + `fontFamily.mono`, plus one custom color ramp (`amber`, `ember`/`ink`, `accent`, `ink`/`accent`, `ink`/`emerald`).                                        |
| Google Fonts pairing = one humanist sans (Inter, 400–800 weights) + one mono (JetBrains Mono or IBM Plex Mono, 400–600)                                                             | **8/11** use this exact pairing (`0000,0001,0003,0004,0005,0009` use Inter+mono; `0002,0007,0008` drop the sans entirely and go all-mono) | Only `sample_0006` (Space Grotesk+JetBrains Mono) and `sample_0010` (Fraunces+Inter, no mono at all) break the "Inter + code font" default.                                                          |
| Copy-to-clipboard button implemented with `navigator.clipboard.writeText(...)`, swap button text to "Copied!"/"copied ✓"/"copied", `setTimeout` revert after ~1500–1600ms           | **4/11** (`0000,0002,0005,0008`)                                                                                                          | Near-identical JS: grab `btn.textContent`, write it back after a fixed timeout. Copy affordance itself (a "$ command" box with a copy button) appears in **6/11** (`0000,0001,0002,0003,0005,0008`). |
| Inline `onclick="..."` handlers instead of addEventListener                                                                                                                         | **3/11** (`0000,0005,0008` partially)                                                                                                     | Mixed with `addEventListener` elsewhere in the same file — inconsistent JS style within a single document.                                                                                           |
| GitHub logo rendered as the identical inline Octocat SVG path (`M12 .5C5.65.5...` / `M8 0C3.58 0...`)                                                                               | **4/11** (`0000,0001,0003,0009`\*)                                                                                                        | Same icon, same viewBox, copy-pasted path data, only decimal precision differs slightly between samples.                                                                                             |

---

## 2. Layout structure

### 2.1 The universal page skeleton

**11/11** samples use the same macro-structure: sticky/simple header nav → centered hero (eyebrow pill + H1 + subhead + 1–2 CTA buttons [+ optional code/terminal panel]) → 1 or more `grid-cols-2/3` feature sections → optional comparison table or install section → closing CTA band → footer with copyright + link row. The only structural outlier is `sample_0006` (Latchkey), which compresses the entire page into a single centered card (a "launch card" format) rather than a scrolling multi-section page.

### 2.2 Hero anatomy (near mechanical repetition)

**10/11** heroes follow this exact vertical stack, in this exact order:

1. Small rounded-full "eyebrow" pill/badge above the headline, containing a colored dot + short status text (`0000` "Written in Rust · MIT licensed", `0001` "v0.9 — Raft-based replication is now GA", `0003` "Sylo v1.4 is live — now with hybrid search", `0004` "SOC 2 Type II report available under NDA", `0007` "v0.9 · apache-2.0 · kubernetes 1.26+", `0008` "v0.9.2 · built with Zig 0.13 · no GC, no runtime", `0010` "A one-person, no-VC log aggregator").
2. Large, bold, tight-tracking H1, 2 lines, with one clause color-highlighted (span in accent color).
3. A muted gray/slate subhead paragraph, `max-w-xl`/`max-w-2xl`, centered.
4. A `flex` row of exactly **two** CTA buttons: one solid/filled primary, one outlined/ghost secondary.
5. (Optional but frequent) a terminal/code panel directly below the CTAs.

Only `sample_0006` (single card) and `sample_0010` (personal-narrative, left-aligned, non-centered hero) deviate from the centered order above.

### 2.3 "Announcement pill" eyebrow badge

`rounded-full` badge, border + subtle bg tint, small colored dot (`w-1.5 h-1.5 rounded-full`) + text, sitting directly above the H1 — **7/11** (`0000,0001,0003,0004,0007,0008,0010` in spirit; `0002` reuses the same shape for its variant-picker pills). The dot is frequently `animate-pulse` (`0002`,`0003`) to imply "live" status.

### 2.4 Feature grids

`grid` with `sm:grid-cols-2` / `md:grid-cols-2` / `lg:grid-cols-3`, each cell = icon-in-a-box + bold heading + 1–2 sentence gray description, inside a bordered/translucent card — **8/11** (`0000,0001,0003,0004,0005,0008,0009` use this almost verbatim; `0010` uses a 2-col variant for its "philosophy" cards). Fenwick (`0000`) and Flint (`0001`) both literally use 6 cards in a `sm:grid-cols-2 lg:grid-cols-3` = 3×2 grid, each with a square icon tile, bold white title, and gray-400 paragraph — differing only in copy and hex values.

### 2.5 Square icon tile before every feature title

A `w-9/w-10/w-11 h-9/h-10/h-11` rounded box, tinted background, containing a centered small SVG or icon, placed directly above/left of the card heading — **4/11** verbatim (`0000,0001,0004,0009` implicitly via icon-tile class), with close analogues (numbered index instead of icon) in `0005` (unicode glyphs ▣◈⟲⬡) and `0008` (numeric `01/02/03` index).

### 2.6 Comparison / "vs the competitor" tables

A `<table>` with the product's own column visually distinguished (colored header text, or a tinted column background) benchmarked against 1–2 named competitors — **4/11** (`0001` vs Kafka/NATS, `0003` vs Pinecone/Weaviate, `0007` vs Istio, `0009` vs GitHub Actions/CircleCI). All four use the same layout: header row in `uppercase` muted text, alternating/divided rows, product's column tinted or bolded, closing italic/small-print disclaimer line below the table ("Benchmarked on...", "Kafka edges out raw throughput...", "\*Self-hosted runner options exist..."). This "we lose on some rows too, for credibility" honesty-move appears in 3 of the 4 (`0003,0007,0009`).

### 2.7 "Problem vs Solution" two-column split

Exactly two columns, left labeled "THE PROBLEM" (or "If you've run X in prod, you know this list"), right labeled "THE SOLUTION" (or "What we actually do") — **3/11** (`0001` explicit THE PROBLEM/THE SOLUTION headers, `0007` pain-list section followed by "what Skiff actually does", `0005`'s "Why not just use Airflow?" callout box does the same rhetorical move in one column).

### 2.8 Numbered section/step labels

Small, tracked-out, uppercase numeric prefixes like `01 — COMPLIANCE`, `02 — AUDIT LOGGING` (`0004`), `01/02/03` feature index (`0008`), `01/02/03/04` migration steps (`0009`) — **3/11**, plus `0002`'s numbered variant-switcher (`01`–`05`) as a structurally identical device repurposed for a different function.

### 2.9 Terminal/code window chrome

A rounded panel with a header bar containing three colored circles (red/yellow/green, imitating macOS window controls) followed by a filename/label, with a monospace body below — **8/11** (`0000,0001,0002,0003,0004,0005,0007,0008`). The three dot colors are drawn from a near-identical palette every time: `#ff5f56` / `#ffbd2e` / `#27c93f` (or Tailwind `red-500/70`, `yellow-500/70`, `green-500/70`). Only `0006`, `0009`, `0010` skip this exact chrome (though `0010` still uses a dark terminal-styled box without the dots).

---

## 3. Color palettes and gradients

### 3.1 Near-universal dark mode

**10/11** samples use a near-black body background (`#05070a`–`#101218` range). The single exception, `sample_0010` (Kindling), flips to a warm cream/light theme (`#FBF5EC`) — notable precisely because it's the _only_ deviation, i.e. "dark developer-tool background" is treated as the unquestioned default 91% of the time.

### 3.2 Accent color is always green/teal or orange/amber — never blue, purple, pink, or red

Across all 11 samples, the single accent color used for links, primary buttons, glowing text, and highlighted spans falls into just two families:

- **Green/teal/mint family — 6/11**: Wick `#3dff8a` (neon terminal green), Sylo `#22c98e`/`#34e2a3` (mint), Ledgerline `#2dd4bf`/`#5eead4` (teal), Skiff `#5eead4` (teal), trace `#5eff9c` (neon green), Forgeline `#34d399` (emerald).
- **Orange/amber family — 4/11**: Fenwick `#f0900a`/`#f5a524` (amber), Flint `#ff7a2f` (ember), Kiln `#f97316` (orange), Kindling `#D9642B` (ember).
- **Lime/acid — 1/11**: Latchkey `#d4ff3d`.

Zero samples pick blue, purple, magenta, or red as the primary brand/accent hue (red is reserved exclusively for "bad/negative" table cells and terminal-dot decoration). This is a strong, specific palette collapse: 11 independently-generated "distinct" brands land in only 3 hue families, and 2 of those 3 are visually adjacent (green and amber both read as "terminal/monospace-native" colors).

### 3.3 Radial-gradient "glow" blob behind the hero

A large, blurred, low-opacity radial gradient positioned above/behind the hero content, in the page's accent color — **9/11** (`0001,0002,0003,0004,0005,0006,0007,0008,0010`... i.e. every sample except `0000` and `0009` uses at least one `radial-gradient(...)` glow effect). Common incantations:

- `radial-gradient(600px circle at 50% 0%, rgba(ACCENT,0.12–0.18), transparent 60–70%)` (`0001`,`0003`)
- Two-blob variant, one top-right + one bottom-left, both `blur-3xl`, both circles (`0010`)
- A `.glow-blob` / `.glow` fixed-position 900px/640px circle with `filter: blur(10px)` (`0002`,`0006`)

### 3.4 Faint grid-line background texture

A tiled `linear-gradient` (or `radial-gradient(circle at 1px 1px,...)`) creating a 1px grid of faint lines, `background-size` between 28px–44px, frequently masked to fade out toward the edges/bottom via `mask-image: radial-gradient(...)` — **5/11** (`0002,0003,0004,0006,0007`, plus `0008` uses the same grid at the `body` level rather than a section overlay = **6/11** total). This is presented as "technical/blueprint" texture behind hero copy in every case.

### 3.5 Translucent bordered "glass" card

`background: linear-gradient(180deg, rgba(255,255,255,0.03-0.035), rgba(255,255,255,0.01))` + `border: 1px solid rgba(255,255,255,0.06-0.09)` used as the generic card/panel surface — **6/11** verbatim (`0000,0001,0004,0005`, plus Tailwind-utility equivalents `bg-white/[0.02-0.04] border-white/10` in `0003,0009`). The exact opacity values (0.03, 0.035, 0.01, 0.06, 0.08, 0.09) recur across files that were (per the prompt) generated independently — i.e., different generations converge on the identical "glass card" recipe down to the second decimal of opacity.

### 3.6 Gradient text (`background-clip: text`)

Only **1/11** (`sample_0003`, `.grad-text`) actually clips a gradient to text, despite the visual trope being extremely common in this genre — most samples opt for a flat single-accent-color span instead. Noted as a near-miss/absence rather than a repeated pattern.

---

## 4. Typography

- **H1 sizing**: every hero headline sits in the `text-4xl` → `text-6xl` range (36px–96px depending on breakpoint), always `font-bold`/`font-extrabold`/`font-semibold` + `tracking-tight`, always 2 lines, always with `leading-tight`/`leading-[1.08-1.15]` — **11/11**.
- **Highlight-one-clause-in-color** headline technique: exactly one phrase inside the H1 is wrapped in a `<span class="text-ACCENT">` while the rest stays white — **9/11** (`0000` "without the Makefile pain", `0001` "one binary", `0002` glow class on whole H1 (variant), `0003` "vector database", `0004` none (whole H1 white — exception), `0005` none (exception), `0006` "grown-up", `0007` "That's the problem.", `0008` "critical path.", `0009` none (exception), `0010` none (exception)). So 3 samples (`0004,0005,0009,0010` — actually 4) skip it, but it's still the dominant move in the majority.
- **Body copy color**: subheads and paragraph text are almost never pure white/black — always a muted gray step (`text-slate-400`, `text-zinc-400`, `text-[#8b949e]`, `var(--muted)`, `text-[var(--text-dim)]`) sitting one or two steps down from the heading color — **11/11**.
- **Monospace-for-everything variants**: 3 samples (`0002` Wick, `0007` Skiff, `0008` trace) set `font-family: monospace` on `*` / `body`, turning the entire page — headings, paragraphs, nav — into a terminal aesthetic, not just code blocks. All three also happen to be in the green-accent family (§3.2), reinforcing "monospace ⇄ green ⇄ hacker/edge/infra" as a single fused stereotype the model reaches for repeatedly.
- **Letter-spacing on eyebrow/label text**: `uppercase tracking-wide` or `tracking-widest` on small labels (nav eyebrows, section labels, table headers) — **4/11+** explicit Tailwind classes (`0001,0002,0003,0005`), plus equivalent custom CSS (`letter-spacing: 0.06em/0.12em` in `0004,0007,0008`) — i.e. essentially universal once custom-CSS equivalents are counted.

---

## 5. Component styles

### 5.1 Navigation bar

`flex items-center justify-between` header, logo+wordmark on the left, 3–5 text nav links center/right, 1 GitHub link/button and 1 primary CTA button on the far right — **10/11** (all except `0006`, the single-card layout with no nav). Sticky positioning (`sticky top-0` + `backdrop-blur` + semi-transparent bg) — **6/11** (`0001,0003,0004,0007,0009,0010`).

### 5.2 Buttons

Every hero (and most closing CTAs) pairs exactly one **filled/solid** button (brand-accent or white background, dark text) with exactly one **outlined/ghost** button (`border border-white/10-15`, transparent bg, hover:bg-white/5-10) — **10/11** (all except `0006`, which uses a single CTA). Border-radius on buttons is `rounded-md` or `rounded-lg` in 9/11; only `0002` and `0010` use fully pill-shaped (`rounded-lg`→ larger radius / `rounded-full`) buttons.

### 5.3 Footer

`<footer>` with a `flex flex-col sm:flex-row items-center justify-between` row: left = one-line copyright/tagline, right = 3–5 text links (`GitHub`, `Docs`, `Discord`/`Changelog`/`Status`/`Contact`) — **10/11** (missing only in `0006`). Exact link sets recur: `GitHub · Docs · Changelog` (`0000`), `GitHub · Docs · Discord · Status` (`0001`), `github · docs · discord` (`0002,0007`), `GitHub · Discord · Twitter` (`0003`), `Docs · Discussions · Contributing · Releases` (`0005`), `github · docs · changelog · discord` (`0008`), `Docs · GitHub · Status · Contact` (`0009`), `GitHub · Docs · Sponsor` (`0010`).

### 5.4 Feature/spec cards

Bordered rounded box, `p-5`/`p-6` padding, containing icon/glyph → bold white heading → 1–2 sentence gray-400 description — the single most repeated component in the corpus, appearing **9/11** times as the _primary_ content unit for benefits, RBAC permissions, trust-center rows, philosophy points, and "what it does" explainers (`0000,0001,0003(compare rows only, less so),0004,0005,0008,0009,0010`, and `0007`'s "what Skiff actually does" tiles).

### 5.5 Badge/pill micro-components

Small `rounded-full`/`rounded-md` chip with border + tinted background, used for: hero eyebrow, "NOW SHIPPING" status (`0006`), shields.io badges row (`0005`: build/license/npm/go/coverage), compliance framework chips (`0004`: SOC 2/ISO/GDPR/FedRAMP), "self-hosted · open-core · SOC 2 ready" (`0009`) — **8/11** use at least one pill/chip component beyond the hero eyebrow itself.

---

## 6. Decorative elements

| Element                                                                                                            | Count | Examples                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------ | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blurred radial "glow" blob                                                                                         | 9/11  | see §3.3                                                                                                                                                                                              |
| Faint dot/line grid background texture                                                                             | 6/11  | see §3.4                                                                                                                                                                                              |
| macOS-style 3-dot terminal chrome                                                                                  | 8/11  | see §2.9                                                                                                                                                                                              |
| Drop/box shadows on cards & buttons (`shadow-2xl shadow-black/40-50`, `box-shadow: 0 8px 24px -8px rgba(...)`)     | 7/11  | `0000,0001,0003,0005,0006,0007(term),0009`                                                                                                                                                            |
| CRT scanline overlay (`repeating-linear-gradient` + `mix-blend-mode: overlay`)                                     | 1/11  | `0002` only — a genre-specific outlier but still a "default hacker trope" reach                                                                                                                       |
| Blinking text cursor (`animation: blink`, `steps(1) infinite`) next to a wordmark or in a typing-effect code block | 3/11  | `0002` (nav logo), `0003` (typed code), `0008` (nav logo) — same visual idea (blinking terminal caret) independently reinvented 3 times with near-identical `@keyframes blink { 50% { opacity: 0 } }` |
| Animated typing/rotating headline via `setInterval`/`setTimeout` JS                                                | 2/11  | `0002` rotates 5 headline variants every 4.5s; `0003` types out a code snippet character-by-character then loops                                                                                      |
| Emoji used as a logo mark or decorative flourish                                                                   | 1/11  | `0010`'s 🔥 flame, animated with a custom `flicker` keyframe                                                                                                                                          |
| Fake/placeholder GitHub star counter with animated count-up                                                        | 1/11  | `0003` (`animateCount`, eased count from 0, `fetch()` to GitHub API with hardcoded `FALLBACK_STARS`)                                                                                                  |
| ASCII/box-drawing architecture diagram inside a `<pre>`                                                            | 1/11  | `0005`                                                                                                                                                                                                |

---

## 7. Copy / rhetorical patterns (content-level "slop")

- **Negative-contrast headline formula** — define the product by what it removes/avoids rather than what it is: "...**without** the Makefile pain" (`0000`), "...**not** a platform team" (`0001`), "...**that don't need** a grown-up in the room" (`0006`), "Istio does everything. **That's the problem.**" (`0007`), "Your CI bill **shouldn't** grow faster than your team" (`0009`), implicitly "**gets out of** the critical path" (`0008`). **6/11** headlines use this exact "subtract the competitor's pain" construction.
- **Triadic negation lists** ("no X, no Y, no Z") used as a rhythm device in body copy: "No ZooKeeper, no etcd, no sidecars to babysit" (`0001`); "No Redis, no Celery, no separate webserver" / "no interpreter, no VM, no dependency tree" (`0005`); "no redeploy, no incident channel, no vibes-based rollback" / "no 'contact sales,' no per-seat tax, no enterprise tier..." (`0006`); "without a second control plane... without 20 CRDs... without a dedicated on-call rotation" (`0007`) — **5/11** use a three-item "no/without" list as a headline or sub-headline rhythm.
- **"Single binary" as the load-bearing value prop** — 7/11 samples (`0000,0001,0003,0005,0007,0008,0009`) center their pitch on shipping as "one/a single (static) binary," even though the products are in unrelated categories (task runner, message queue, vector DB, workflow engine, service mesh, API gateway, CI runner). This is the single most repeated _substantive claim_ in the batch.
- **Self-aware "we're not perfect" honesty section** — a dedicated block admitting limitations/what's not good yet, explicitly framed as a credibility move: `0005`'s "Why not just use Airflow?" callout, `0007`'s "What we're not good at yet" box, `0003`/`0009`/`0001`'s comparison tables that concede a losing row on purpose. **4–5/11**.
- **Em dash as the default punctuation for appositive asides** — every single sample uses em dashes (literal `—` or `&mdash;`) to bolt a clarifying clause onto a sentence, from 1 up to 17 times in one document (`0007`). **11/11**, frequency ranging 1–17 occurrences per file.
- **"Under NDA" / benchmark-with-caveat disclaimers in fine print** below tables/claims ("Benchmarked on 1M x 768-dim vectors...", "Kafka edges out raw throughput...", "Illustrative monthly cost using public list pricing...") — **4/11** (`0001,0003,0004,0009`).
- **Placeholder customer quote never filled in** — `0009` ships a testimonial block with literal bracket placeholders `[Customer Name]`, `[Title, Company] — placeholder pending case study approval` left in the "final" copy — a tell that the generation treated the social-proof section as structurally mandatory even with no real content to put there.

---

## 8. Spacing & proportion habits

- **Section vertical rhythm**: `py-16` / `py-20` (occasionally `py-24`) is used for nearly every full-width section across every sample, producing visually identical section heights regardless of content density — **11/11** use one of these three values as the dominant section padding.
- **Container width lottery**: containers cluster almost entirely on Tailwind's default scale — `max-w-4xl`, `max-w-5xl`, `max-w-6xl`, `max-w-7xl` — with `max-w-6xl` being the single most common choice (appears in `0001,0003,0009` as the dominant wrapper, plus repeatedly within `0004,0007`). No sample uses a bespoke/non-default max-width value.
- **Card padding**: `p-5` or `p-6` for feature/spec cards is the default in essentially every card-based section (`0000,0001,0004,0005,0008,0009,0010`), regardless of how much text the card holds — short 1-line list items and dense 3-sentence descriptions receive the same fixed padding.
- **Gap values**: flexbox/grid `gap` is almost always `gap-3`, `gap-4`, or `gap-6` — finer-grained values (`gap-2`, `gap-5`, `gap-8`+) appear far less often, suggesting the generations default to the same handful of "round" spacing tokens rather than tuning per-context.
- **Icon size convergence**: decorative/feature SVG icons are sized `16px`–`20px` (`w-4`/`w-5` or explicit `width="16-20"`) in nearly every card across every sample, regardless of the icon tile's own size (which itself clusters at `w-9`–`w-11`, i.e. 36–44px) — the icon-to-container ratio (roughly 45–55%) is reproduced almost exactly across unrelated samples.

---

## 9. Pattern frequency summary (quick reference)

| Pattern                                                     | Samples exhibiting it | Count |
| ----------------------------------------------------------- | --------------------- | ----- |
| `preconnect` to Google Fonts                                | all                   | 11/11 |
| Em dash used for asides                                     | all                   | 11/11 |
| Dark (near-black) body background                           | all but Kindling      | 10/11 |
| Tailwind Play CDN `<script>`                                | all but trace         | 10/11 |
| Two-button hero CTA row (solid + outline)                   | all but Latchkey      | 10/11 |
| Footer = copyright left, link row right                     | all but Latchkey      | 10/11 |
| Accent color from green/teal or orange/amber family only    | all                   | 11/11 |
| H1 = 2 lines, bold/extrabold, tracking-tight                | all                   | 11/11 |
| Feature-card grid (icon/index + heading + gray description) | most                  | 9/11  |
| Radial-gradient glow blob behind hero                       | most                  | 9/11  |
| One clause of H1 highlighted in accent color                | most                  | 9/11  |
| macOS 3-dot terminal/code window chrome                     | most                  | 8/11  |
| "Single/one binary" positioned as core value prop           | majority              | 7/11  |
| Grid-line background texture                                | over half             | 6/11  |
| "Glass card" translucent bordered panel recipe              | over half             | 6/11  |
| Sticky header with backdrop-blur                            | over half             | 6/11  |
| Copy-to-clipboard command box with JS revert-after-timeout  | over half             | 6/11  |
| Negative-contrast ("without X", "not Y") headline formula   | over half             | 6/11  |
| Comparison table vs named competitor(s)                     | over a third          | 4/11  |
| Triadic "no X, no Y, no Z" list rhythm                      | under half            | 5/11  |
| Numbered section/step labels (`01 —`, `01/02/03`)           | small                 | 3/11  |
| Whole-page monospace body font (terminal aesthetic)         | small                 | 3/11  |
| Blinking text-cursor caret animation                        | small                 | 3/11  |

**Bottom line:** the batch's diversity is almost entirely surface-level (different product names, different micro-color-hues within the same two hue families, different copy). Structurally — page skeleton, hero anatomy, card recipe, button pairing, footer shape, terminal-window chrome, glow-blob decoration, and even the rhetorical shape of the headlines — 8 to 11 of the 11 "independently generated" samples are running the same small set of templates.
