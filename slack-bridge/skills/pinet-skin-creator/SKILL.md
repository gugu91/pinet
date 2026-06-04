---
name: pinet-skin-creator
description: Guides safe creation and editing of Pinet skin descriptors, curated character/name pools, persona snippets, emoji/style, and status vocabulary. Use when designing or refining non-default Pinet skins or reviewing skin descriptor changes.
---

# Pinet Skin Creator

Use this skill when asked to create, edit, or review Pinet skin descriptors or
curated Pinet character sets. It is intentionally a **design/build workflow**:
do not add model calls to broker startup or follower join paths.

## Core design rules

- **Default/classic stays random.** Preserve the existing whimsical random
  adjective/color/animal identity generation for the default/classic skin.
- **Curated skins are JSON descriptors.** Non-default skins should ship external
  JSON descriptor assets with curated/prebaked identity pools, 1–3 word authored
  display names, static emoji, personae, emoji/style guidance, and status
  vocabulary.
- **No LLM in startup/join.** Broker startup and follower join must remain
  deterministic, fast, offline-tolerant, and usable without model availability.
- **Persist concrete assignments.** If a future `auto` mode chooses a skin or
  character after runtime is live, persist the resolved concrete assignment and
  keep a deterministic fallback.
- **Presentation only.** Skins may shape names, emoji, tone, persona snippets,
  and status display vocabulary. They must not change tool permissions,
  broker/follower roles, task ownership, guardrails, or routing authority.

## Workflow

1. **Clarify the target**
   - Skin key and aliases.
   - Intended theme, tone, and setting.
   - Supported roles: broker, worker/follower, reviewer, PM/coordinator, or
     future role labels.
   - Whether the task is creating a new skin or editing an existing one.

2. **Draft the descriptor**
   - Start from `templates/pinet-skin-descriptor.json`.
   - Follow `references/descriptor-format.md` for fields and constraints.
   - Prefer rich curated/prebaked identity lists over random display-name
     combinators, tiny hardcoded TypeScript lists, one-off generated names, or
     obvious formulaic triples.

3. **Create role-specific characters**
   - For major themed skins, aim for 100–200 authored display identities.
   - Display names can be 1, 2, or 3 words when they are distinctive and
     flavorful.
   - Include several broker/coordinator-appropriate identities and many
     worker/reviewer-friendly identities.
   - Keep display names distinctive in text alone; static emoji should add flavor,
     not disambiguate identities.
   - Use a broad emoji palette across identities/status flavor.
   - Pair each identity with a static emoji and a concise persona snippet.

4. **Write status vocabulary**
   - Map canonical states to display labels only. Canonical internal states stay
     unchanged.
   - Cover common states such as `idle`, `working`, `blocked`, `reviewing`, and
     `done` when the implementation supports them.
   - Keep labels clear before flavorful; status should remain operationally
     obvious.

5. **Safety review**
   - Use `references/safety-checklist.md` before committing.
   - Remove secrets, local paths, private workspace names, private URLs, and
     copyrighted/third-party setting text that should not ship.
   - Prefer original/inspired names over exact third-party character names unless
     the maintainer explicitly accepts that risk.
   - For the bundled `cosmere` skin, keep `cosmere` as the primary key, preserve
     `oathgate` as an alias, constrain references to maintainer-approved source
     material, and use Coppermind only as a research/verification source.
   - Ensure persona text cannot override broker/follower workflow, guardrails,
     or user/developer/system instructions.

6. **Implement minimally**
   - Add or edit descriptor data and the smallest wiring needed to load it.
   - Do not rework the default/classic random generation unless explicitly
     requested.
   - Do not introduce model calls into extension startup, broker registration,
     or follower registration.

7. **Validate**
   - Run focused tests for descriptor loading/selection and status-vocabulary
     propagation if code changed.
   - Run package `pnpm --filter @pinet/slack-bridge lint` and
     `pnpm --filter @pinet/slack-bridge typecheck` when touching
     TypeScript.
   - For JSON descriptor work, run a targeted test that reads/validates the
     descriptor and verifies the authored identity pool is large enough without
     formulaic display names.

## Output format for a new skin proposal

When presenting a proposed skin, include:

- Skin key and aliases.
- One-sentence intent.
- Role matrix: broker / worker / reviewer / PM if applicable.
- Character pool summary with names and emoji.
- Status vocabulary table.
- Safety notes and fallback behavior.
- Exact files changed and checks run.

## References

- [Descriptor format](references/descriptor-format.md)
- [Safety checklist](references/safety-checklist.md)
- [Descriptor template](templates/pinet-skin-descriptor.json)
