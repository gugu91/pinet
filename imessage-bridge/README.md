# @pinet/imessage-bridge

Thin macOS/iMessage **send-first** package for the `extensions` repo.

## What this slice does

This package now covers the smallest useful live transport path:

- adapter-local readiness checks for a local macOS iMessage MVP
- an AppleScript-backed outbound adapter for **send-first** delivery
- transport-local helpers that the shared broker/runtime core can call without burying iMessage logic inside `slack-bridge`

## Current MVP shape

The current implementation is intentionally narrow:

- **macOS only**
- **send-first**
- **AppleScript delivery** through `/usr/bin/osascript`
- **shared-core delivery** via the broker adapter seam
- **local history readiness** still modeled against `~/Library/Messages/chat.db`

That means outbound sends can work even when the local Messages database is unavailable, while startup/readiness reporting still makes the history blocker explicit.

## Trust boundary notes

`@pinet/imessage-bridge` is an intentional **same-host local-power surface**.

- When enabled, outbound sends run through the local Messages app via `/usr/bin/osascript` as the current macOS user.
- There is no extra approval or policy layer inside this package today; the trust boundary is local operator intent on the same host.
- The current MVP is still **send-first**, so outbound capability can be ready even when local history access is unavailable.
- Missing `chat.db` only blocks local history/readiness depth. It does **not** remove the outbound send power when AppleScript remains available.

Treat this as explicit local outbound power, not as a remote-safe transport or a generic policy-enforced messaging surface.

In the current repo bring-up path, enable the adapter with `slack-bridge.imessage.enabled: true` and start the broker runtime with `/pinet start`.

## What stays in this package

- readiness detection
- canonical local path assumptions for the Messages database
- AppleScript send helper + adapter-local transport code
- stable default thread-id helper for send-first bring-up

## Publishing

This package is included in the full npm publish set tracked in
[`../plans/npm-publish.md`](../plans/npm-publish.md). Use the GitHub Actions
workflow's default dry-run/readiness path for validation; do not publish, tag, or
bump versions without explicit maintainer release approval.

## What stays out of scope

- inbound iMessage sync
- chat database query plumbing
- generic transport UI redesign
- WhatsApp or other transport work
- broad Slack/Pinet separation cleanup beyond the existing broker adapter seam

## Example

```ts
import {
  createIMessageAdapter,
  detectIMessageMvpEnvironment,
  getDefaultIMessageThreadId,
} from "@pinet/imessage-bridge";

const readiness = detectIMessageMvpEnvironment();
if (readiness.canAttemptSend) {
  const adapter = createIMessageAdapter();
  await adapter.connect();
  await adapter.send({
    threadId: getDefaultIMessageThreadId("chat:alice"),
    channel: "chat:alice",
    text: "hello from pi",
  });
}
```
