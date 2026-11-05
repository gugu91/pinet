# Runtime owner

Issue: https://github.com/gugu91/pinet/issues/1118 (slice 1)

Status: proposal. Nothing here is built yet.

## Problem

A Pinet process can run as off, single player, broker or follower. Today no
single piece of code owns that choice. The state is spread across `index.ts`,
`follower-runtime.ts` and `broker/client.ts`:

- `index.ts` keeps eight mutable fields: `pinetEnabled`, `currentRuntimeMode`,
  `brokerRole`, `brokerClient`, `pinetLifecycleTail`, `pinetReloadPromise`,
  `pendingStartup` and `followerRuntimeDiagnostic` (`index.ts:737–744`). They
  are read or written in 132 places in that file alone.
- Changes are serialized by a promise chain, `runPinetLifecycle`. Some paths
  skip it. For example, `/pinet unfollow` calls `disconnectFollower` directly
  (`pinet-commands.ts:421–435`).
- The follower keeps its own client reference, poll flag, ack promise and two
  status-sync fields (`follower-runtime.ts:133–139`). Its reconnect callback runs
  as a detached async function (`follower-runtime.ts:463–494`).
- `BrokerClient` tracks its connection with `socket`, `connectingSocket`,
  `connected`, `shuttingDown`, a reconnect timer, a heartbeat timer and an
  attempt counter (`broker/client.ts:220–242`). `connect()` does not guard
  against overlapping calls. Close handlers do not check which socket closed.
  `connected` becomes true before authentication and registration finish.
- The mode that survives `/reload` is a process-global symbol
  (`index.ts:148`). It is written only when no startup is in progress.

### What goes wrong in practice

The evidence comment on #1118 found these in local Pi transcripts:

| Symptom                                                                                                        | Where it comes from                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A worker got "Not connected to broker" five times in two hours. Sends in between succeeded.                    | `request()` rejects at once while the client is reconnecting (`broker/client.ts:766`).                                                                                                        |
| `pinet agents` and `pinet lanes` returned "Pinet is not running" during a session.                             | Tools throw unless the runtime has already settled (`pinet-tools.ts:1177` and others). They do not wait for a start that is in progress.                                                      |
| After `/reload`, followers did not reconnect. A real-socket test showed an explicit unfollow undone by reload. | Mode, role and reload state live in separate fields with separate paths. #1101 fixed the module cache and carried the mode across reload, but the paths that can drift apart are still there. |

The module-cache part of the reload incident was a separate cause, and #1101
fixed it. This design does not change module loading.

## Goals

1. One owner decides which role runs, and every entry point goes through it.
   The entry points are `/pinet` commands, `session_start`, `session_shutdown`,
   reload and terminal reconnect failures.
2. Every socket, timer, poll loop and child process belongs to exactly one
   owner. Stopping the owner stops all of them and waits for them to finish.
3. A result from old async work cannot change current state.
4. Short gaps, such as a reconnect or a start in progress, make callers wait
   briefly instead of failing.
5. The agent-facing tools stay the same.

## Non-goals

- No new dependencies. The primitives below are about 150 lines.
- No change to the broker database in this slice. That is slice 2.
- The broker role, single player, subtree broker and Socket Mode keep their
  current internals in this slice. They are wrapped as children so that
  stopping cascades, and they move onto the primitives in slice 5.

## Design

### 1. `Scope`: the owner of resources

```ts
interface Scope {
  readonly signal: AbortSignal;
  defer(cleanup: () => void | Promise<void>): void;
  setInterval(fn: () => void | Promise<void>, ms: number): void;
  setTimeout(fn: () => void | Promise<void>, ms: number): void;
  run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T>;
  child(): Scope;
  close(): Promise<void>;
}
```

- `close()` aborts the signal, closes child scopes, then runs cleanups in
  reverse order. It returns once all of them, including any work started with
  `run`, have finished.
- A scope's interval does not start a new tick while the previous tick is still
  running. On close, it waits for the running tick. This replaces
  `followerPollRunning`, `brokerMaintenanceRunning` and similar flags.
- A closed scope rejects new work. A late callback therefore cannot start a
  timer that nothing will stop.

### 2. `Machine`: a state machine with a mailbox and epochs

```ts
interface MachineSpec<S extends { kind: string }, E extends { type: string }> {
  initial: S;
  step(state: S, event: E): { state: S; effects?: Effect<E>[] };
}

type Effect<E> = (scope: Scope) => Promise<E | void>;
```

- `step` is pure. It is tested with tables, like `tmux/helpers.ts`.
- Each state gets a fresh epoch and a fresh child scope. Effects run in the
  scope of the state that started them. When the state changes, that scope
  closes, so its work is aborted and its timers stop.
- An effect's result comes back as an event tagged with its epoch. The machine
  drops any event whose epoch is no longer current. This one rule removes the
  "late async result" class of bugs in this area.
- Events are processed one at a time, in order. `send(event)` queues the event.
  `settled(predicate, timeoutMs)` resolves when the state matches the predicate.

### 3. `PinetRuntime`: the root

```ts
type Mode = "off" | "single" | "broker" | "follower";

type RuntimeState =
  | { kind: "off"; diagnostic?: RuntimeDiagnostic }
  | { kind: "starting"; target: Exclude<Mode, "off"> }
  | { kind: "running"; role: Role }
  | { kind: "stopping"; next: Mode; releaseIdentity: boolean };

type Role =
  | { mode: "single"; slack: SinglePlayerHandle }
  | { mode: "broker"; broker: BrokerHandle }
  | { mode: "follower"; connection: BrokerConnection };

type RuntimeEvent =
  | { type: "set_mode"; mode: Mode }
  | { type: "reload" }
  | { type: "shutdown"; reason: "quit" | "reload" }
  | { type: "started"; role: Role }
  | { type: "start_failed"; error: Error }
  | { type: "stopped" }
  | { type: "role_failed"; error: Error };
```

- **One public interface:**
  - `setMode(mode)`, `reload()` and `shutdown(reason)`;
  - `current()`, which returns the state;
  - `whenRunning(timeoutMs)`.

  The `/pinet` commands, `session_start`, `session_shutdown` and the follower's
  terminal reconnect failure call only these.

- **Latest request wins.** A `set_mode` that arrives during `starting` aborts
  the start and goes to the new target. Today a second request waits behind the
  first in the promise chain.
- **Unfollow is `setMode("off")`.** No path skips the machine. The mode carried
  across reload is the mode last requested, so an explicit unfollow stays off.
- **Reload** stops the role with `releaseIdentity: false`, then starts the same
  mode. Reloading broker adapters in place is an operation on the broker role,
  not on the root.
- **Carrying state across `/reload`.** Pi replaces the module, so the root
  cannot carry itself. `session_shutdown` writes one typed record,
  `{ desiredMode }`, to the existing process-global symbol. `session_start`
  reads it and deletes it. Unlike today, a reload during startup carries the
  target mode instead of falling back to settings.
- **Tools wait instead of failing.** Pinet tools call `whenRunning(timeoutMs)`.
  During `starting`, they wait for the start to finish. They fail with the
  current reason only when the state is `off` or the wait times out. Tool
  registration is synced on each transition into `running` or `off`.

### 4. `BrokerConnection`: replaces the connection handling in `BrokerClient`

```ts
type ConnectionState =
  | { kind: "idle" }
  | { kind: "connecting"; attempt: number }
  | { kind: "authenticating"; socket: net.Socket }
  | { kind: "registering"; socket: net.Socket }
  | { kind: "ready"; socket: net.Socket; identity: RegistrationResult }
  | { kind: "backoff"; attempt: number; lastError: Error }
  | { kind: "closed" }
  | { kind: "failed"; reason: "name_conflict" | "worker_key_rejected"; error: Error };
```

- Only one socket exists at a time, and it belongs to the current state's scope.
  A socket's handlers send events tagged with the epoch they were created in. A
  close event from an old socket is dropped.
- `isConnected()` is true only in `ready`. Today `connected` is true from the
  moment the socket opens.
- The heartbeat timer belongs to the `ready` scope. It cannot outlive the
  connection that started it.
- **Requests during a reconnect wait.** A new request made in `connecting`,
  `authenticating`, `registering` or `backoff` waits for `ready` within the
  existing 5-second request timeout, then sends. A request already sent when the
  socket closes is still rejected, because the broker may have applied it. This
  removes the "Not connected to broker" failures seen in practice, without
  sending anything twice.
- **Re-registration is part of the machine.** On reconnect, the `registering`
  state runs the follower's registration hook as an effect. The hook covers
  identity refresh, reclaiming threads and syncing status. `ready` is reached
  only after it finishes. This replaces the detached `onReconnect` callback.
- Terminal registration errors go to `failed`. The root receives `role_failed`,
  moves to `off` and keeps the reason as a diagnostic.
- The typed RPC methods (`register`, `pollInbox`, `send` and so on) keep their
  signatures. `worker-cli.ts` and the follower use the new connection.

### 5. Follower role

The follower role's scope holds:

```
FollowerRole
├─ BrokerConnection
├─ Poller          scope.setInterval; one tick at a time; close waits for it
├─ StatusSync      latest desired status wins (becomes Reconciler<T> in slice 4)
└─ AckFlush        awaited on stop
```

- The poller gets its connection from its parent role, so there is no
  `clientRef?.client !== client` check.
- Stopping the role flushes acks, stops the poller and closes the connection,
  in that order. This replaces `disconnect()` and `resetFollowerRuntimeState()`.
- The three follower delivery-tracking sets stay as they are until slice 3.

### 6. Other roles in this slice

The broker, single player and subtree broker keep their implementations. Each
gets a small adapter with `start(scope)` and `stop()`, registered with
`scope.defer`. The subtree broker becomes a child of the role that started it,
so stopping that role stops it too.

## What this deletes

- From `index.ts`: the eight ownership fields, `runPinetLifecycle`,
  `cancelPendingStartup`, `runRuntimeModeTransition`, `transitionToRuntimeMode`,
  `connectAsFollower` and `disconnectFollower`, plus the duplicated reset code
  in `stopPinetRuntime` and the startup error path.
- From `helpers.ts`: `reloadPinetRuntimeSafely` and
  `reloadPinetRuntimeInPlaceSafely`, replaced by the root's reload transition.
- From `follower-runtime.ts`: `clientRef`, `followerPollRunning`,
  `wasDisconnected`, `followerAckPromise` and the status-sync promise fields.
- From `broker/client.ts`: `connectingSocket`, `connected`, `shuttingDown`,
  `reconnectTimer`, `heartbeatTimer`, `reconnectAttempt`, the handler fields
  and `reconnectOnce`.

## Testing

1. **Reducer tables.** Write table tests for `step` in the root and the
   connection, with one row per state and event. Include a row checking that
   an event from an old epoch changes nothing.
2. **Model-based tests.** A seeded generator produces random sequences of
   events and checks invariants after every step. The generator is about
   30 lines, with no new dependency (agent default, not requested). The events
   are:
   - `setMode`, `reload` and `shutdown`;
   - socket open, close and error;
   - authentication and registration success or conflict;
   - timer ticks.

   It runs these against a fake transport and a manual clock. The invariants:
   - At most one socket is open.
   - `isConnected()` is true exactly when the state is `ready`.
   - No timer or socket is alive after `shutdown`.
   - Once the machine settles, the mode is the mode last requested.
   - A request is never sent twice.

   The sequences that produce today's bugs must fail against the current code.
   For example: two `connect` calls overlap; a close arrives from an old socket;
   unfollow is followed by reload; or a request is made during a reconnect.

3. **Real sockets.** Keep the existing socket-harness tests for reload and
   unfollow, and make them run against the new root.
4. **End to end.** Run a scratch broker on a temporary socket and database, and
   a follower in Pi's RPC mode with a current model calling real tools. Then
   restart the scratch broker while the follower is sending, and check:
   - every send succeeds;
   - the follower reconnects;
   - `/reload` keeps the mode;
   - unfollow followed by reload stays off.

   Do not test against the user's live broker.

## Delivery

Three PRs. Each one deletes the code it replaces.

1. **Primitives.** `Scope` and `Machine`, with their own tests. Nothing uses
   them yet.
2. **`BrokerConnection`.** Rewrite the connection handling in
   `broker/client.ts`. Move the follower and `worker-cli.ts` onto it, and move
   the follower's reconnect handling into the `registering` state.
3. **`PinetRuntime`.** Replace the ownership fields and lifecycle chain in
   `index.ts`. Route every command and session event through the root, wrap the
   other roles, and make tools wait with `whenRunning`.

## Open questions

1. **How long to wait.** How long should tools wait for a start in progress?
   The proposal is 10 seconds (agent default, not requested). Joins started
   with `--pinet-follow` already wait for the start to finish before the first
   prompt.
2. **Retrying reads.** Should read-only requests that were in flight when the
   socket closed be retried once? The proposal is to retry `pollInbox`,
   `listAgents`, `listThreads` and `readInbox` without `markRead`, and nothing
   else.
3. **Scratch broker for testing.** A temporary `HOME` isolates the leader lock
   and database, because both default to paths under `~/.pi`
   (`broker-core/leader.ts:8`). But Socket Mode allows one connection per Slack
   app token. A scratch broker using the production app token would take over
   the live broker's Slack connection. The end-to-end test therefore needs one
   of these:
   - a broker that can start without the Slack adapter;
   - a separate test Slack app.
