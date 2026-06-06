# Proposal: split `slack-bridge` into Pinet core + Slack adapter

- Follow-up to #264
- Related: #531, #349, #350, #351, #352, #353, #401, #442, #444, #448, #420
- Status: planning only — no runtime move in this PR
- Last updated: 2026-04-22

## Executive summary

`slack-bridge` is no longer just a Slack package.

It currently bundles four layers:

1. **Slack adapter code** — Slack API calls, Socket Mode ingress, Block Kit, Home tabs, canvases, manifest deployment, Slack tools.
2. **Pinet runtime orchestration** — broker/follower lifecycle, inbox draining, session UI, persistence, remote control, agent status, Ralph loop wiring.
3. **Broker kernel glue** — broker client/server/bootstrap wrappers that are mostly transport-neutral and already partially extracted to `broker-core`.
4. **Shared utilities** — settings, identity helpers, caches, task parsing, git helpers.

The lowest-regret target is **not** to create two peer extensions that both try to own runtime state. The better split is:

- keep **`@pinet/slack-bridge`** as the published **Slack adapter extension package** and compatibility entrypoint
- add **`@pinet/pinet-core`** as a **library package** for broker/runtime/Pinet orchestration
- continue using **`@pinet/broker-core`** for transport-neutral broker kernel code, and move more broker primitives there instead of leaving them under `slack-bridge/broker/*`

That keeps the runtime composition model simple:

```text
pi session
  └─ @pinet/slack-bridge (extension entrypoint / Slack adapter)
       ├─ @pinet/pinet-core (runtime orchestration)
       ├─ @pinet/broker-core (broker kernel)
       └─ @pinet/transport-core (transport contracts)
```

## Current topology

### Workspace/package topology today

- `slack-bridge/` is one package: `@pinet/slack-bridge`
- package export surface is only:
  - `.` → `./dist/index.js`
  - `./package.json`
- package `pi.extensions` points to `./dist/index.js`
- root workspace `pi.extensions` points to `./slack-bridge/index.ts`
- there is **no `imports` map** in `slack-bridge/package.json`; composition is all internal relative imports
- `slack-bridge` already depends on:
  - `@pinet/broker-core`
  - `@pinet/transport-core`
  - `@pinet/imessage-bridge`
- `broker-core/` already exists and `slack-bridge/broker/agent-messaging.ts` is already a shim that re-exports `@pinet/broker-core/agent-messaging`

### Runtime wiring today

`slack-bridge/index.ts` is the composition root.

It directly wires:

- Slack request runtime
- Slack runtime access helpers
- single-player Slack Socket Mode runtime
- broker runtime
- follower runtime
- session UI runtime
- persisted runtime state
- agent prompt / agent event runtime
- Pinet home tabs and control-plane canvas surfaces
- tool registration (`slack`, `pinet`, `imessage`)
- command registration (`/pinet <action>`)

`index.ts` imports **35 local modules** today. That confirms the runtime has been modularized, but the package boundary is still tangled.

### Prior direction from planning docs

`plans/pinet-vision.md` points toward:

- one message primitive
- one broker control plane
- workers as computation, broker as infrastructure
- thin extensions at the edges

`plans/420-broker-daemon-prd.md` reinforces the same direction:

- Slack ownership is an adapter concern
- broker/runtime ownership should move toward durable infrastructure
- refactored seams inside `slack-bridge` are a stepping stone, not the final boundary

## Proposed topology

## Recommended package split

### 1) Keep and slim `@pinet/slack-bridge`

Purpose: **Slack adapter only**.

Responsibilities:

- Slack API access and request lifecycle
- Slack Socket Mode ingress
- Slack event normalization
- Slack tool registration
- Block Kit / modal helpers
- Home tab and canvas rendering/publishing
- Slack-origin policy / confirmation / reaction-trigger behavior
- single-player direct Slack runtime
- top-level extension entrypoint that composes Slack adapter + Pinet core

### 2) Add `@pinet/pinet-core`

Purpose: **runtime orchestration library**.

Responsibilities:

- broker/follower runtime lifecycle orchestration
- inbox drain + delivery tracking
- persisted runtime state
- session UI integration
- agent completion / remote-control / mesh status flows
- Pinet tools and slash commands
- Ralph loop orchestration
- tracked task assignment parsing/resolution
- shared non-Slack runtime helpers and ports

This package should **not** own a `pi.extensions` entrypoint in phase 1.
It should be a library used by `@pinet/slack-bridge`.

### 3) Continue expanding `@pinet/broker-core`

Purpose: **transport-neutral broker kernel**.

Responsibilities:

- broker DB base schema and contracts
- agent routing / direct messaging / broadcast messaging
- leader lock / auth / paths / raw TCP loopback checks
- broker socket server + broker client
- broker bootstrap (`startBroker`) and JSON-RPC transport

This is already started. The existing `broker-core/agent-messaging.ts` re-export is real evidence that the split has begun.

## Why this shape is better than “two peer extension packages”

A peer-extension split would force runtime state to be shared indirectly across two loaded extensions.
That is higher risk because today one package still owns:

- the in-memory inbox
- session UI badge state
- broker/follower runtime transitions
- persisted runtime restoration
- agent event wiring

Making `pinet-core` a library first avoids inventing a second extension-to-extension coordination protocol before the core extraction is finished.

## Classification inventory

Below is the current source inventory bucketed by intent.

### A. Slack-specific / should stay in `@pinet/slack-bridge`

- `activity-log.ts`
- `broker-thread-owner-hints.ts`
- `broker/adapters/slack.ts`
- `canvases.ts`
- `core-tool-guardrails.ts`
- `deploy-manifest.ts`
- `guardrails.ts`
- `home-tab.ts`
- `index.ts`
- `pinet-control-plane-canvas.ts`
- `pinet-home-tabs.ts`
- `reaction-triggers.ts`
- `runtime-mode.ts`
- `single-player-runtime.ts`
- `slack-access.ts`
- `slack-api.ts`
- `slack-block-kit.ts`
- `slack-export.ts`
- `slack-message-context.ts`
- `slack-modals.ts`
- `slack-presence.ts`
- `slack-request-runtime.ts`
- `slack-runtime-access.ts`
- `slack-scope-diagnostics.ts`
- `slack-socket-dedup.ts`
- `slack-tool-policy-runtime.ts`
- `slack-tools.ts`
- `slack-turn-guardrails.ts`
- `slack-upload.ts`
- `thread-confirmations.ts`

### B. Broker / Pinet runtime core

- `agent-completion-runtime.ts`
- `agent-event-runtime.ts` _(after Slack policy is injected instead of imported directly)_
- `agent-prompt-guidance.ts` _(after Slack reaction prompt guidance is injected instead of imported directly)_
- `broker-delivery.ts`
- `broker-runtime-access.ts`
- `broker-runtime.ts`
- `command-registration-runtime.ts`
- `follower-delivery.ts`
- `follower-runtime.ts`
- `git-metadata.ts`
- `imessage-tools.ts` _(runtime-facing, but see open question below)_
- `inbox-drain-runtime.ts`
- `persisted-runtime-state.ts`
- `pinet-activity-formatting.ts`
- `pinet-agent-status.ts`
- `pinet-commands.ts`
- `pinet-maintenance-delivery.ts`
- `pinet-mesh-ops.ts`
- `pinet-registration-gate.ts`
- `pinet-remote-control-acks.ts`
- `pinet-remote-control.ts`
- `pinet-skin.ts`
- `pinet-tools.ts`
- `ralph-loop.ts`
- `scheduled-wakeups.ts`
- `session-ui-runtime.ts`
- `task-assignments.ts`
- `ttl-cache.ts`

### C. Shared helpers / split-first blockers

These are the files that should **not** be moved as-is because they mix Slack and core concerns.

- `helpers.ts`
- `runtime-agent-context.ts`
- `tool-registration-runtime.ts`
- `broker/control-plane-canvas.ts`
- `broker/schema.ts`
- `broker/adapters/types.ts`

### D. Broker-kernel wrappers that should stop living under `slack-bridge`

Some of these are already just compatibility shims over `broker-core`.

- `broker/agent-messaging.ts`
- `broker/auth.ts`
- `broker/client.ts`
- `broker/index.ts`
- `broker/leader.ts`
- `broker/maintenance.ts`
- `broker/message-send.ts`
- `broker/paths.ts`
- `broker/raw-tcp-loopback.ts`
- `broker/router.ts`
- `broker/socket-server.ts`
- `broker/types.ts`

## File-by-file move list

This is the recommended destination map for the actual extraction.

### Move into `pinet-core/`

- `slack-bridge/agent-completion-runtime.ts`
- `slack-bridge/agent-event-runtime.ts` _(after extracting Slack tool-policy wiring behind a port)_
- `slack-bridge/agent-prompt-guidance.ts` _(after extracting Slack reaction guidance behind a port)_
- `slack-bridge/broker-delivery.ts`
- `slack-bridge/broker-runtime-access.ts`
- `slack-bridge/broker-runtime.ts` _(after replacing direct `SlackAdapter`/`SlackActivityLogger`/canvas dependencies with injected ports)_
- `slack-bridge/command-registration-runtime.ts`
- `slack-bridge/follower-delivery.ts`
- `slack-bridge/follower-runtime.ts`
- `slack-bridge/git-metadata.ts`
- `slack-bridge/imessage-tools.ts` _(temporary; later candidate to move toward `imessage-bridge`)_
- `slack-bridge/inbox-drain-runtime.ts`
- `slack-bridge/persisted-runtime-state.ts`
- `slack-bridge/pinet-activity-formatting.ts`
- `slack-bridge/pinet-agent-status.ts`
- `slack-bridge/pinet-commands.ts`
- `slack-bridge/pinet-maintenance-delivery.ts`
- `slack-bridge/pinet-mesh-ops.ts`
- `slack-bridge/pinet-registration-gate.ts`
- `slack-bridge/pinet-remote-control-acks.ts`
- `slack-bridge/pinet-remote-control.ts`
- `slack-bridge/pinet-skin.ts`
- `slack-bridge/pinet-tools.ts`
- `slack-bridge/ralph-loop.ts`
- `slack-bridge/scheduled-wakeups.ts`
- `slack-bridge/session-ui-runtime.ts`
- `slack-bridge/task-assignments.ts`
- `slack-bridge/ttl-cache.ts`

### Keep in `slack-bridge/` as adapter-only code

- `slack-bridge/activity-log.ts`
- `slack-bridge/broker-thread-owner-hints.ts`
- `slack-bridge/broker/adapters/slack.ts`
- `slack-bridge/canvases.ts`
- `slack-bridge/core-tool-guardrails.ts`
- `slack-bridge/deploy-manifest.ts`
- `slack-bridge/guardrails.ts`
- `slack-bridge/home-tab.ts`
- `slack-bridge/index.ts` _(becomes a thin composer over `pinet-core` + Slack adapter)_
- `slack-bridge/pinet-control-plane-canvas.ts`
- `slack-bridge/pinet-home-tabs.ts`
- `slack-bridge/reaction-triggers.ts`
- `slack-bridge/runtime-mode.ts`
- `slack-bridge/single-player-runtime.ts`
- `slack-bridge/slack-access.ts`
- `slack-bridge/slack-api.ts`
- `slack-bridge/slack-block-kit.ts`
- `slack-bridge/slack-export.ts`
- `slack-bridge/slack-message-context.ts`
- `slack-bridge/slack-modals.ts`
- `slack-bridge/slack-presence.ts`
- `slack-bridge/slack-request-runtime.ts`
- `slack-bridge/slack-runtime-access.ts`
- `slack-bridge/slack-scope-diagnostics.ts`
- `slack-bridge/slack-socket-dedup.ts`
- `slack-bridge/slack-tool-policy-runtime.ts`
- `slack-bridge/slack-tools.ts`
- `slack-bridge/slack-turn-guardrails.ts`
- `slack-bridge/slack-upload.ts`
- `slack-bridge/thread-confirmations.ts`

### Move further down into `broker-core/`

- `slack-bridge/broker/client.ts`
- `slack-bridge/broker/index.ts`
- `slack-bridge/broker/socket-server.ts`

### Delete compatibility wrappers after imports are rewritten

These should stop being owned by `slack-bridge` once callers use `@pinet/broker-core/*` directly.

- `slack-bridge/broker/agent-messaging.ts`
- `slack-bridge/broker/auth.ts`
- `slack-bridge/broker/leader.ts`
- `slack-bridge/broker/maintenance.ts`
- `slack-bridge/broker/message-send.ts`
- `slack-bridge/broker/paths.ts`
- `slack-bridge/broker/raw-tcp-loopback.ts`
- `slack-bridge/broker/router.ts`
- `slack-bridge/broker/types.ts`

### Split before moving

- `slack-bridge/helpers.ts`
  - split into core identity/runtime helpers vs Slack HTTP/config helpers
- `slack-bridge/runtime-agent-context.ts`
  - split into core runtime-state context + Slack adapter config context
- `slack-bridge/tool-registration-runtime.ts`
  - split into core registration (`pinet`, maybe iMessage) vs adapter registration (`slack`)
- `slack-bridge/broker/control-plane-canvas.ts`
  - move pure snapshot/render data pieces toward core, keep Slack canvas API publishing in adapter
- `slack-bridge/broker/schema.ts`
  - retain broker-core base schema where it is, move Pinet-specific Ralph-cycle extension to `pinet-core`
- `slack-bridge/broker/adapters/types.ts`
  - replace with direct imports from `@pinet/transport-core`

## Proposed public API surface

## `@pinet/pinet-core`

Recommended exported surface:

- broker/follower runtime orchestration
  - `createBrokerRuntime`
  - `createFollowerRuntime`
  - `createBrokerRuntimeAccess`
- Pinet runtime helpers
  - `createInboxDrainRuntime`
  - `createPersistedRuntimeState`
  - `createSessionUiRuntime`
  - `createPinetAgentStatus`
  - `createPinetMeshOps`
  - `createPinetRemoteControl`
  - `createPinetRemoteControlAcks`
  - `createPinetRegistrationGate`
  - `createPinetMaintenanceDelivery`
  - `createPinetActivityFormatting`
  - `createPinetMeshSkin`
- Pinet operator surface
  - `registerPinetTools`
  - `registerPinetCommands`
- Ralph/task/shared utilities
  - `createRalphLoopState`
  - `startRalphLoop`
  - `stopRalphLoop`
  - task-assignment parsing/resolution helpers
  - caches, scheduling helpers, git metadata helpers
- adapter ports/types
  - `MessageAdapterFactory`
  - `ActivityLoggerPort`
  - `HomeTabPublisherPort`
  - `ControlPlaneCanvasPort`
  - `SlackOriginPolicyPort` _(name can change; intent is “origin-specific policy hook”)_

This package should **not** export a default extension entrypoint in phase 1.

## `@pinet/slack-bridge`

Recommended exported surface:

- default extension entrypoint
- Slack adapter runtime helpers
  - `createSlackRequestRuntime`
  - `createSlackRuntimeAccess`
  - `createSinglePlayerRuntime`
  - `createSlackAdapter` / `SlackAdapter`
- Slack tools / UI helpers
  - `registerSlackTools`
  - Block Kit/modal helpers
  - Home tab rendering/publishing helpers
  - control-plane canvas publishing helpers
- Slack manifest / deployment helpers

## `@pinet/broker-core`

Recommended export additions:

- `BrokerClient`
- `BrokerSocketServer`
- `startBroker`

It already owns most of the rest of the transport-neutral broker kernel.

## Breaking changes / migration notes

### For published consumers

Recommended approach: **avoid a package rename for existing Slack users**.

- keep `@pinet/slack-bridge` as the package users install for Slack
- do not require users to install `@pinet/pinet-core` directly in phase 1
- keep the `pi.extensions` entrypoint in `@pinet/slack-bridge`

That makes the split mostly internal at first.

### For internal imports

These imports should eventually change:

- from `./broker/*` wrappers
- to `@pinet/broker-core/*` or `@pinet/pinet-core/*`

### For settings/config

Current settings are all under the `slack-bridge` key in `~/.pi/agent/settings.json`.

Recommended migration policy:

- **Phase 1:** keep existing `slack-bridge.*` settings names as the source of truth
- **Phase 2:** optionally add `pinet-core.*` aliases for transport-neutral runtime settings
- **Phase 3:** warn on deprecated aliases only after the split has shipped and stabilized

Do **not** rename config eagerly in the same PR as the package extraction.

### For runtime modes

- `single` mode remains Slack-adapter-only
- `broker` and `follower` orchestration move to `pinet-core`, but are still started by the Slack adapter package
- the top-level mode decision logic can stay in the adapter because it depends on Slack tokens/app-shell behavior

## Test-file relocation plan

General rule: move each `*.test.ts` with its source file.

### Tests that should follow `pinet-core`

- `agent-completion-runtime.test.ts`
- `agent-event-runtime.test.ts`
- `broker-delivery.test.ts`
- `broker-runtime-access.test.ts`
- `broker-runtime.test.ts`
- `command-registration-runtime.test.ts`
- `follower-delivery.test.ts`
- `git-metadata.test.ts`
- `inbox-drain-runtime.test.ts`
- `persisted-runtime-state.test.ts`
- `pinet-activity-formatting.test.ts`
- `pinet-agent-status.test.ts`
- `pinet-maintenance-delivery.test.ts`
- `pinet-mesh-ops.test.ts`
- `pinet-registration-gate.test.ts`
- `pinet-remote-control-acks.test.ts`
- `pinet-remote-control.test.ts`
- `pinet-skin.test.ts`
- `pinet-tools.test.ts`
- `ralph-loop.test.ts`
- `runtime-mode.test.ts` _(if mode resolution stays adapter-owned, keep this one in Slack instead)_
- `scheduled-wakeups.test.ts`
- `session-ui-runtime.test.ts`
- `task-assignments.test.ts`
- `ttl-cache.test.ts`

### Tests that should stay with the Slack adapter

- `activity-log.test.ts`
- `broker-thread-owner-hints.test.ts`
- `broker/adapters/slack.test.ts`
- `canvases.test.ts`
- `core-tool-guardrails.test.ts`
- `deploy-manifest.test.ts`
- `guardrails.test.ts`
- `home-tab.test.ts`
- `pinet-control-plane-canvas.test.ts`
- `pinet-home-tabs.test.ts`
- `reaction-triggers.test.ts`
- `single-player-runtime.test.ts`
- `slack-api.test.ts`
- `slack-block-kit.test.ts`
- `slack-export.test.ts`
- `slack-message-context.test.ts`
- `slack-modals.test.ts`
- `slack-presence.test.ts`
- `slack-request-runtime.test.ts`
- `slack-runtime-access.test.ts`
- `slack-scope-diagnostics.test.ts`
- `slack-socket-dedup.test.ts`
- `slack-tool-policy-runtime.test.ts`
- `slack-tools.test.ts`
- `slack-upload.test.ts`
- `thread-confirmations.test.ts`

### Tests that should shrink or be split

- `index.test.ts`
  - split into:
    - thin Slack composition/entrypoint tests in `slack-bridge`
    - core orchestration tests closer to `pinet-core`
- `broker/integration.test.ts`
  - likely split between `broker-core` transport tests and `pinet-core` runtime integration tests
- `broker/helpers.test.ts`
  - rewrite once `broker/*` wrappers disappear

## `pnpm-workspace` and Turbo impact

### `pnpm-workspace.yaml`

Add:

- `pinet-core`

Keep existing:

- `broker-core`
- `transport-core`
- `slack-bridge`
- `slack-api`

### `turbo.json`

No structural change is required for the scaffold.

The existing task model is already package-local:

- `lint`
- `typecheck`
- `test`

Once `pinet-core` has standard scripts, Turbo will pick it up automatically.

### Root `package.json`

No immediate change required to root `pi.extensions` for the planning PR.
The root can continue to load `./slack-bridge/index.ts` while that file becomes a thin adapter/composer.

## Risks and open questions

1. **`helpers.ts` is the biggest blocker**
   - it mixes Slack HTTP, settings loading, identity logic, inbox formatting, mesh helpers, task parsing, and more.
   - package extraction will be painful until this is split.

2. **`broker-runtime.ts` is still adapter-aware**
   - it directly constructs `SlackAdapter`
   - it uses `SlackActivityLogger`
   - it coordinates Home tab / canvas refresh paths
   - this must become port-driven before the file can move cleanly.

3. **`ralph-loop.ts` and control-plane publishing are entangled**
   - Ralph evaluation is core logic
   - Slack control-plane publishing is adapter logic
   - keep the evaluation/report data in core and push publishing behind an adapter callback.

4. **`BrokerSocketServer` still exposes `slack.proxy`**
   - transport-neutral package, Slack-named RPC method
   - either keep as a compatibility alias, or introduce a neutral adapter-proxy concept and preserve `slack.proxy` as legacy naming.

5. **`imessage-tools.ts` is boundary-ambiguous**
   - it is not Slack-specific
   - but it is also not Pinet-core in the purest sense
   - likely acceptable to move into `pinet-core` first, then re-home later with `imessage-bridge` if needed.

6. **Settings namespace split can create user-facing churn**
   - avoid eager config renames
   - keep backward compatibility until runtime extraction has stabilized.

7. **Single-player mode is intentionally adapter-owned**
   - this is correct, but it means `slack-bridge` remains a meaningful package even after extraction.

## Phased rollout

### Phase 0 — this PR

- document the target architecture
- add `pinet-core/` workspace scaffold only
- do not move runtime code yet

### Phase 1 — split helpers and ports

- split `helpers.ts`
- split `runtime-agent-context.ts`
- split `tool-registration-runtime.ts`
- define adapter ports used by `broker-runtime.ts`, `agent-event-runtime.ts`, and `ralph-loop.ts`

### Phase 2 — move broker/runtime core

- create `@pinet/pinet-core` real exports
- move runtime/Pinet modules into `pinet-core/`
- update imports in `slack-bridge/index.ts`

### Phase 3 — finish broker-core downshift

- move `broker/client.ts`, `broker/socket-server.ts`, `broker/index.ts` into `broker-core/`
- remove `slack-bridge/broker/*` compatibility wrappers
- keep any Pinet-specific DB extension in `pinet-core`

### Phase 4 — cut over Slack adapter

- make `slack-bridge/index.ts` a thin composer
- keep Slack-only tools, single-player mode, Home tabs, canvases, manifest deployment in `slack-bridge`
- verify no behavior changes for broker/follower startup

### Phase 5 — cleanup

- trim `index.test.ts`
- rewrite integration tests around the new package seams
- optionally introduce config aliases/deprecation notices
- update READMEs/docs to describe the layered package model

## Recommendation

Proceed with the split using this package boundary:

- **`@pinet/broker-core`** = transport-neutral broker kernel
- **`@pinet/pinet-core`** = broker/follower/runtime/Pinet orchestration library
- **`@pinet/slack-bridge`** = Slack adapter extension and compatibility package

That boundary best matches the current code shape, the prior Pinet planning docs, and the existing partial extraction work already landed under #531 and related refactors.
