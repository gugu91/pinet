# Changelog

All notable changes to this repository are documented in this file.

## Release note policy

Readiness-only npm publishing workflow or documentation changes do not by
themselves create a new release entry, tag, or package version. Add a versioned
entry only when a maintainer approves a real release with intentional package
version bumps and publish scope.

## [0.2.3] - 2026-06-30

Pinet v0.2.3 keeps the coordinated `@pinet/*` package set aligned and includes the Slack/Pinet fixes merged after the v0.2.2 release prep.

### Version verification

- `pi-extensions` — `0.2.3` (private repo package)
- `@pinet/transport-core` — `0.2.3`
- `@pinet/broker-core` — `0.2.3`
- `@pinet/pinet-core` — `0.2.3`
- `@pinet/imessage-bridge` — `0.2.3`
- `@pinet/slack-bridge` — `0.2.3`
- `@pinet/model-aware-compaction` — `0.2.3`

### Release highlights

- Requires explicit Pinet invocation before guarded Slack-context routing so uninvoked guarded Slack messages do not start unintended assistant work.
- Fixes Slack mrkdwn bold rendering by preserving `*bold*` output instead of converting it to unsupported double-asterisk Markdown.
- Adds Pinet worker session lookup support so broker/operator tooling can resolve worker sessions more reliably.

### Included pull requests since v0.2.2

- [#837](https://github.com/gugu91/extensions/pull/837) — Add Pinet worker session lookup
- [#838](https://github.com/gugu91/extensions/pull/838) — Require explicit Pinet invocation in guarded Slack contexts
- [#840](https://github.com/gugu91/extensions/pull/840) — Fix Slack Markdown bold rendering

## [0.2.2] - 2026-06-26

Pinet v0.2.2 keeps the coordinated `@pinet/*` package set aligned and fixes proactive compaction interrupting active model/tool loops.

### Version verification

- `pi-extensions` — `0.2.2` (private repo package)
- `@pinet/transport-core` — `0.2.2`
- `@pinet/broker-core` — `0.2.2`
- `@pinet/pinet-core` — `0.2.2`
- `@pinet/imessage-bridge` — `0.2.2`
- `@pinet/slack-bridge` — `0.2.2`
- `@pinet/model-aware-compaction` — `0.2.2`

### Release highlights

- Defers model-aware proactive compaction until `agent_end`, after the complete model/tool loop has settled.
- Prevents manual compaction from aborting the model continuation that consumes a completed tool result.
- Adds lifecycle regression coverage without injecting a synthetic continuation message.

### Included pull requests since v0.2.1

- [#846](https://github.com/gugu91/extensions/pull/846) — fix: compact after agent loop settles

## [0.2.1] - 2026-06-26

Pinet v0.2.1 keeps the coordinated `@pinet/*` package set aligned and adds `@pinet/model-aware-compaction` as its sixth package.

### Version verification

- `pi-extensions` — `0.2.1` (private repo package)
- `@pinet/transport-core` — `0.2.1`
- `@pinet/broker-core` — `0.2.1`
- `@pinet/pinet-core` — `0.2.1`
- `@pinet/imessage-bridge` — `0.2.1`
- `@pinet/slack-bridge` — `0.2.1`
- `@pinet/model-aware-compaction` — `0.2.1` (initial release)

### Release highlights

- Adds model-aware proactive compaction with ordered exact or wildcard model rules and active-context token limits.
- Prevents duplicate compactions while one is in flight and adds optional diagnostics plus `/model-aware-compaction-status`.
- Keeps the existing Pinet libraries and bridges version-aligned on `0.2.1`.
- Includes the compact Pinet read-help refinements merged after `0.2.0`.

### Included pull requests since v0.2.0

- [#842](https://github.com/gugu91/extensions/pull/842) — docs(pinet): make compact read defaults explicit
- [#844](https://github.com/gugu91/extensions/pull/844) — feat: add model-aware compaction extension

## [0.2.0] - 2026-06-17

Pinet v0.2.0 is the first coordinated `@pinet/*` package release cut from the current `main` branch. It intentionally includes only work already merged through PR #829 and aligns all publishable Pinet packages on the same version.

### Version verification

- `pi-extensions` — `0.2.0` (private repo package)
- `@pinet/transport-core` — `0.2.0`
- `@pinet/broker-core` — `0.2.0`
- `@pinet/pinet-core` — `0.2.0`
- `@pinet/imessage-bridge` — `0.2.0`
- `@pinet/slack-bridge` — `0.2.0`

### Release highlights

- Adds worker-owned Pinet subtree broker support for safer distributed worker coordination.
- Improves Slack/Pinet operator surfaces: raw Slack file access, channel-post file handling, compact dispatcher output by default, expanded human-readable Pinet tables, send previews, and the app-name agents slash command.
- Hardens Slack reaction-trigger routing, including ignoring reaction triggers by default, denying uninvoked-thread reaction routing, and canonicalizing guarded delete actions from resolved targets.
- Guards npm package GitHub metadata for the public package set.
- Preserves Slack/external requeue affinity so disconnected-owner follow-ups do not drift to unrelated idle workers.
- Tightens broker cleanup prompt policy for safer maintenance behavior.

### Included pull requests since v0.1.2

- [#766](https://github.com/gugu91/extensions/pull/766) — feat(pinet): support worker-owned subtree brokers
- [#807](https://github.com/gugu91/extensions/pull/807) — feat(slack): support raw Slack file access
- [#808](https://github.com/gugu91/extensions/pull/808) — fix(slack): support files on channel posts
- [#810](https://github.com/gugu91/extensions/pull/810) — fix(slack-bridge): ignore Slack reaction triggers by default
- [#813](https://github.com/gugu91/extensions/pull/813) — fix(slack-bridge): deny reaction routing in uninvoked threads
- [#815](https://github.com/gugu91/extensions/pull/815) — fix(slack-bridge): canonicalize guarded delete actions from resolved targets
- [#826](https://github.com/gugu91/extensions/pull/826) — fix: guard npm package GitHub metadata
- [#825](https://github.com/gugu91/extensions/pull/825) — fix(pinet): keep dispatcher output compact by default
- [#823](https://github.com/gugu91/extensions/pull/823) — feat(pinet): human-readable expanded agents table + send preview (#763, #762)
- [#805](https://github.com/gugu91/extensions/pull/805) — feat(slack): add app-name agents slash command
- [#828](https://github.com/gugu91/extensions/pull/828) — fix(pinet): preserve Slack requeue affinity
- [#829](https://github.com/gugu91/extensions/pull/829) — Tighten broker cleanup prompt policy

## [0.1.4] - 2026-04-23

Pinet v0.1.4 is a focused patch release for `@gugu910/pi-slack-bridge` that fixes Slack external file-upload requests to use the form encoding Slack expects. The runtime behavior change is intentionally narrow: `slack_upload` should stop failing with `invalid_arguments` when it calls `files.getUploadURLExternal` and `files.completeUploadExternal`.

### Version verification

- `pi-extensions` — `0.1.4` (private repo package)
- `@gugu910/pi-slack-bridge` — `0.1.4`
- `@gugu910/pi-nvim-bridge` — `0.1.0` (unchanged)
- `@gugu910/pi-neon-psql` — `0.1.0` (unchanged)
- `@gugu910/pi-slack-api` — `0.2.0` (unchanged)

### Release highlights

- Form-encodes `files.getUploadURLExternal` and `files.completeUploadExternal` in the shared Slack request helper so Slack file uploads no longer send JSON to endpoints that expect URL-encoded form bodies.
- Adds focused regression coverage for both external upload methods, including structured payload serialization for the completion request.

## [0.1.3] - 2026-04-08

Pinet v0.1.3 is a narrow follow-up patch for `@gugu910/pi-slack-bridge` after `0.1.2` was published with real Slack identifiers in the package README settings example. Because published npm tarballs are immutable, this release corrects the npm-visible package surface with scrubbed example placeholders while leaving the runtime behavior unchanged.

### Version verification

- `pi-extensions` — `0.1.3` (private repo package)
- `@gugu910/pi-slack-bridge` — `0.1.3`
- `@gugu910/pi-nvim-bridge` — `0.1.0` (unchanged)
- `@gugu910/pi-neon-psql` — `0.1.0` (unchanged)
- `@gugu910/pi-slack-api` — `0.2.0` (unchanged)

### Release highlights

- Scrubs the npm-facing `slack-bridge/README.md` settings example so `allowedUsers` and `defaultChannel` use obviously fake placeholders instead of real Slack identifiers.
- Keeps the publish surface otherwise aligned with `0.1.2`; this is a release-docs correction patch before the next publish.

## [0.1.2] - 2026-04-08

Pinet v0.1.2 is a refreshed patch release for `@gugu910/pi-slack-bridge` cut from current `main`. The earlier `0.1.1` repo prep never shipped to npm, so this release supersedes that unpublished cut while keeping the release surface intentionally focused: the Slack bridge package bumps to `0.1.2`, the private monorepo package moves to `0.1.2` for repo-level version tracking, and the other workspace packages stay at their current versions.

### Version verification

- `pi-extensions` — `0.1.2` (private repo package)
- `@gugu910/pi-slack-bridge` — `0.1.2`
- `@gugu910/pi-nvim-bridge` — `0.1.0` (unchanged)
- `@gugu910/pi-neon-psql` — `0.1.0` (unchanged)
- `@gugu910/pi-slack-api` — `0.2.0` (unchanged)

### Release highlights

- Carries forward the unpublished `0.1.1` prep surface already on `main`: mesh-auth hardening, structured control messages, Home tab/dashboard work, stable-ID thread binding, backlog recovery, and `slack_project_create`.
- Finishes publish-surface polish for the public Slack bridge package, including MIT license packaging, runtime TypeBox dependency placement, and dry-run pack verification improvements.
- Fixes several operator-facing Pinet reliability gaps that landed after the original `0.1.1` prep: closeout ack echo loops, stale worker-status residue, broker-targeted backlog recovery during inbox sync, top-level Slack tool recovery after reload, bogus operator-update task residue, and Slack thread reply routing / durable explicit takeover handling.
- Includes the merged helper-only skin-voice guidance refresh that shipped on `main` after the earlier prep.

### Included pull requests since the unpublished `0.1.1` prep

- [#302](https://github.com/gugu91/extensions/pull/302) — chore: adopt MIT license for repo and workspace packages
- [#303](https://github.com/gugu91/extensions/pull/303) — fix: stop Pinet closeout acknowledgement echo loops (#299)
- [#305](https://github.com/gugu91/extensions/pull/305) — fix: finish slack-bridge 0.1.1 publish hygiene
- [#306](https://github.com/gugu91/extensions/pull/306) — fix: stop stale worker status residue
- [#308](https://github.com/gugu91/extensions/pull/308) — fix: recover broker-targeted backlog during inbox sync (#307)
- [#310](https://github.com/gugu91/extensions/pull/310) — fix: recover top-level Slack tools after reload (#279)
- [#311](https://github.com/gugu91/extensions/pull/311) — fix: stop operator update task residue (#309)
- [#313](https://github.com/gugu91/extensions/pull/313) — feat: enrich Pinet skin voice guidance (#270)
- [#321](https://github.com/gugu91/extensions/pull/321) — fix: keep Slack thread replies on the right worker (#319)

## [0.1.1] - 2026-04-08

Pinet v0.1.1 was the original unpublished release-prep cut for `@gugu910/pi-slack-bridge`. It is kept here for historical context because `0.1.2` supersedes it as the first publish-ready patch cut after `0.1.0`.

### Version verification

- `pi-extensions` — `0.1.1` (private repo package)
- `@gugu910/pi-slack-bridge` — `0.1.1`
- `@gugu910/pi-nvim-bridge` — `0.1.0` (unchanged)
- `@gugu910/pi-neon-psql` — `0.1.0` (unchanged)
- `@gugu910/pi-slack-api` — `0.2.0` (unchanged)

### Release highlights

- Hardened Pinet coordination with configurable shared-secret mesh auth, structured control messages, reconnect refresh, and headless-subagent isolation.
- Documented the v0.1.1 mesh-auth behavior now visible on `main`: optional auth when unset, `meshSecret` / `meshSecretPath` settings and `PINET_MESH_SECRET` / `PINET_MESH_SECRET_PATH` env fallbacks, friendly missing-secret-file failures for configured followers, and explicit older/no-auth broker compatibility errors with no silent downgrade.
- Added the Pinet Home tab dashboard, an end-user README refresh, and broker routing fixes such as stable-ID thread binding.
- Fixed targeted backlog recovery so stale targeted A2A backlog no longer remains stranded after purge and maintenance.
- Fixed broker-targeted startup backlog recovery so persisted post-restart pending backlog is rebound during startup instead of waiting for a later maintenance pass.
- Included Slack bridge package surface updates that shipped in the same cut, including `slack_project_create` and channel canvas dedup.

### Included pull requests

- [#231](https://github.com/gugu91/extensions/pull/231) — feat: add Pinet Home tab dashboard
- [#243](https://github.com/gugu91/extensions/pull/243) — fix: auto-refresh Pinet registration on reconnect
- [#244](https://github.com/gugu91/extensions/pull/244) — fix: stop headless subagents from joining Pinet
- [#250](https://github.com/gugu91/extensions/pull/250) — feat: structure Pinet control messages
- [#257](https://github.com/gugu91/extensions/pull/257) — feat: add pinet mesh authentication with local shared secret
- [#258](https://github.com/gugu91/extensions/pull/258) — feat: add slack_project_create tool
- [#268](https://github.com/gugu91/extensions/pull/268) — fix: thread binding uses stable IDs first, fuzzy name as fallback
- [#272](https://github.com/gugu91/extensions/pull/272) — fix: drop stale targeted backlog after purge
- [#289](https://github.com/gugu91/extensions/pull/289) — fix: make Pinet mesh secret config-driven and optional
- [#292](https://github.com/gugu91/extensions/pull/292) — fix: clarify Pinet auth method mismatch
- [#298](https://github.com/gugu91/extensions/pull/298) — fix: recover broker-targeted backlog during startup

## [0.1.0] - 2026-04-02

First public release prep for the Pi extensions monorepo. This cut rolls up 66 pull requests merged on 2026-04-02 and aligns with the publish-ready package metadata landed in [#222](https://github.com/gugu91/extensions/pull/222).

> Note: issue #196 was originally filed as `v0.0.1`, but the publish-ready package versions on `main` are already `0.1.0`, so this changelog follows the versions actually present in the repo.

### Version verification

- `pi-extensions` — `0.1.0`
- `@gugu910/pi-slack-bridge` — `0.1.0`
- `@gugu910/pi-nvim-bridge` — `0.1.0`
- `@gugu910/pi-neon-psql` — `0.1.0`
- `@gugu910/pi-slack-api` — `0.1.0`
- `@gugu910/pi-ext-types` — `0.1.0`

### Release highlights

- Slack Bridge grew into a much broader operator surface: scheduling, uploads, canvases, Block Kit, bookmarks, pinning, exports, modals, presence, deploy tooling, and broker observability.
- Pinet broker/worker coordination was hardened across routing, reconnects, stale agent cleanup, RALPH reporting, wake-ups, inbox delivery, worktree enforcement, and broadcast/delegation flows.
- Packaging and workspace infrastructure were prepared for public npm distribution with publish metadata, generated Slack API packaging, shared types, and expanded automated coverage.

### Features (24)

- [#116](https://github.com/gugu91/extensions/pull/116) — ralph loop nudge followUp delivery + agent observability (#102, #103)
- [#152](https://github.com/gugu91/extensions/pull/152) — expose agent PIDs in pinet_agents tool output (#117)
- [#180](https://github.com/gugu91/extensions/pull/180) — add pinet-unfollow command (#176)
- [#181](https://github.com/gugu91/extensions/pull/181) — report worker task completion status in RALPH loop
- [#187](https://github.com/gugu91/extensions/pull/187) — add pinet reload and exit controls (#118)
- [#189](https://github.com/gugu91/extensions/pull/189) — steer delegation through Pinet
- [#190](https://github.com/gugu91/extensions/pull/190) — enforce main-checkout worktree rule
- [#193](https://github.com/gugu91/extensions/pull/193) — add Pinet broadcast channels
- [#194](https://github.com/gugu91/extensions/pull/194) — add scheduled Pinet wake-ups
- [#200](https://github.com/gugu91/extensions/pull/200) — add Slack canvas tools (#26)
- [#201](https://github.com/gugu91/extensions/pull/201) — add Slack file upload tool (#34)
- [#204](https://github.com/gugu91/extensions/pull/204) — add Slack manifest deploy command
- [#206](https://github.com/gugu91/extensions/pull/206) — add agent-name personalities
- [#208](https://github.com/gugu91/extensions/pull/208) — add generated Slack API workspace package
- [#213](https://github.com/gugu91/extensions/pull/213) — add Slack scheduled message tool (#33)
- [#216](https://github.com/gugu91/extensions/pull/216) — add Slack pinning and bookmarks tools (#25)
- [#218](https://github.com/gugu91/extensions/pull/218) — add pinet idle/free signal (#214)
- [#219](https://github.com/gugu91/extensions/pull/219) — add reaction-triggered Slack actions
- [#220](https://github.com/gugu91/extensions/pull/220) — add Slack thread export tool (#29)
- [#221](https://github.com/gugu91/extensions/pull/221) — add Slack Block Kit support (#27)
- [#224](https://github.com/gugu91/extensions/pull/224) — add Slack presence awareness
- [#225](https://github.com/gugu91/extensions/pull/225) — add broker control plane canvas dashboard (#217)
- [#229](https://github.com/gugu91/extensions/pull/229) — add Slack modal workflows
- [#230](https://github.com/gugu91/extensions/pull/230) — add broker activity log channel (#30)

### Fixes (34)

- [#113](https://github.com/gugu91/extensions/pull/113) — allow Ralph loop follow-up repeats after cooldown
- [#115](https://github.com/gugu91/extensions/pull/115) — deliver pinet messages to broker's own inbox
- [#145](https://github.com/gugu91/extensions/pull/145) — enforce single-broker lock to prevent split-brain (#119)
- [#146](https://github.com/gugu91/extensions/pull/146) — add color entropy to agent names (issue #120)
- [#148](https://github.com/gugu91/extensions/pull/148) — broker routing regression + worker reply tool rules (#121, #122)
- [#150](https://github.com/gugu91/extensions/pull/150) — clean up stale agent rows and orphaned threads on purge (issue #140)
- [#151](https://github.com/gugu91/extensions/pull/151) — cap Slack API retry at 3 attempts to prevent infinite recursion (#124)
- [#153](https://github.com/gugu91/extensions/pull/153) — add hard broker guardrails to prevent coding (#107)
- [#154](https://github.com/gugu91/extensions/pull/154) — make claimThread atomic to prevent TOCTOU race (#125)
- [#155](https://github.com/gugu91/extensions/pull/155) — bound in-memory caches with TTL + max-size eviction (#129)
- [#159](https://github.com/gugu91/extensions/pull/159) — clean unregister inbox rows and requeue a2a work (#137)
- [#160](https://github.com/gugu91/extensions/pull/160) — add proper types for activeBroker and brokerClient (Issue #126)
- [#161](https://github.com/gugu91/extensions/pull/161) — clear broken reconnect state after re-register failure (#139)
- [#162](https://github.com/gugu91/extensions/pull/162) — remove blocking execSync from agent metadata lookup (#133)
- [#163](https://github.com/gugu91/extensions/pull/163) — harden broker JSON-RPC request validation (#147)
- [#166](https://github.com/gugu91/extensions/pull/166) — remove dead code client-extension.ts
- [#167](https://github.com/gugu91/extensions/pull/167) — centralize hardcoded socket and database paths
- [#168](https://github.com/gugu91/extensions/pull/168) — warn when SQLite WAL mode falls back (#142)
- [#169](https://github.com/gugu91/extensions/pull/169) — keep local subagents out of the Pinet mesh (#156)
- [#170](https://github.com/gugu91/extensions/pull/170) — share TypeBox through workspace package (#144)
- [#177](https://github.com/gugu91/extensions/pull/177) — stop replaying stale RALPH ghost alerts
- [#178](https://github.com/gugu91/extensions/pull/178) — abort in-flight Slack API calls on shutdown (#135)
- [#179](https://github.com/gugu91/extensions/pull/179) — keep follower a2a traffic out of the Slack inbox (#175)
- [#183](https://github.com/gugu91/extensions/pull/183) — tighten broker client typing (#126)
- [#184](https://github.com/gugu91/extensions/pull/184) — expire stale Slack confirmation state
- [#185](https://github.com/gugu91/extensions/pull/185) — detect psql binary path across platforms (#141)
- [#186](https://github.com/gugu91/extensions/pull/186) — harden follower inbox delivery across restart
- [#192](https://github.com/gugu91/extensions/pull/192) — keep broker db authoritative for thread tracking (#131)
- [#195](https://github.com/gugu91/extensions/pull/195) — add timestamp to RALPH loop messages (#191)
- [#198](https://github.com/gugu91/extensions/pull/198) — report initial RALPH task status (#197)
- [#205](https://github.com/gugu91/extensions/pull/205) — use broker-specific generated names (#202)
- [#209](https://github.com/gugu91/extensions/pull/209) — timestamp all RALPH loop messages (#191)
- [#211](https://github.com/gugu91/extensions/pull/211) — route direct-addressed Slack threads (#207)
- [#226](https://github.com/gugu91/extensions/pull/226) — dedup retried Slack Socket Mode events

### Infrastructure & Quality (6)

- [#171](https://github.com/gugu91/extensions/pull/171) — consolidate duplicate Slack API wrappers (Issue #130)
- [#173](https://github.com/gugu91/extensions/pull/173) — extract Slack API and tool registrations from slack-bridge index (#127)
- [#174](https://github.com/gugu91/extensions/pull/174) — add nvim-bridge coverage (#134)
- [#188](https://github.com/gugu91/extensions/pull/188) — cover neon-psql core query helpers (#149)
- [#212](https://github.com/gugu91/extensions/pull/212) — cover neon-psql query execution path (#149)
- [#222](https://github.com/gugu91/extensions/pull/222) — prep packages for npm publish readiness

### Docs (2)

- [#210](https://github.com/gugu91/extensions/pull/210) — refresh repo README
- [#228](https://github.com/gugu91/extensions/pull/228) — add Pinet philosophy section
