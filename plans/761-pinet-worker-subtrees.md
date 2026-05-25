# #761 Pinet worker subtrees implementation note

This branch now distinguishes two subtree models:

1. The original staging model: supervised children register in the central broker DB with typed parent/root hierarchy metadata.
2. The desired runtime model: a worker can become a local subtree broker, and child workers connect to that worker-owned broker socket instead of the central Pinet broker.

The desired model is the one to complete. The central broker should keep seeing the supervising worker, while child workers report into the supervising worker's local broker.

## Implemented in this branch

- Adds typed agent hierarchy fields in the broker database: parent/root ids, tree depth, spawned-by audit, supervision state, launch id, subtree role, and lane id.
- Accepts hierarchy metadata during real Pinet follower registration, including env-derived metadata from broker-managed launches.
- Preserves the broker protocol boundary for the staging model: supervised children are normal broker-connected followers, but ordinary broadcasts/backlog assignment exclude supervised children.
- Adds subtree-aware A2A policy: parent/child/ancestor/descendant messages are allowed; unrelated workers cannot directly message supervised children; broker emergency overrides remain explicit.
- Adds lifecycle handling: child exit notifies its parent; parent unregister/reap/purge marks descendants orphaned and sends child orphan notices.
- Extends `pinet action=agents` with explicit `scope=children|subtree` plus hierarchy details in full output.
- Adds `pinet action=spawn` as a validation surface that returns a precise blocker until the real launcher/bootstrap contract exists.
- Adds `/pinet subtree start` (alias `/pinet subbroker start`) so a follower worker can keep following the central broker while starting a separate local broker socket/database under `~/.pi/pinet-subtrees/<worker>/`.
- Adds `PINET_SOCKET_PATH` support for followers, allowing child workers to connect to a worker-owned subtree broker instead of the central `~/.pi/pinet.sock` broker.
- Routes subtree broker inbox reads back through the supervising worker, so `pinet action=read args.thread_id=<subtree-a2a-thread>` resolves child messages from the subtree broker DB.

## Current local smoke result

A tmux smoke verified the desired routing path:

- Parent worker followed the central broker.
- Parent ran `/pinet subtree start` and received a dedicated socket/database plus child launch environment.
- Child worker launched with `PINET_SOCKET_PATH=<parent-subtree-socket>` and `PINET_PARENT_AGENT_ID=<subbroker-self-id>`.
- Child registered only in the subtree broker DB as `supervised`, not in the central broker DB.
- Child sent an A2A report to the parent broker id.
- Parent received the subtree pointer and `pinet action=read` returned the child message body from the subtree broker DB.

## Remaining work for full parity

- Wire `pinet action=spawn` to a real tmux/process launcher that uses the `/pinet subtree start` environment instead of returning `missing_broker_connected_worker_launcher`.
- Add broker-style child roster/status operations scoped to the active subtree broker, not just read routing.
- Add durable lane metadata for subtree brokers: tmux session, socket path, DB path, parent worker id, and cleanup TTL.
- Make startup settings path handling respect `PI_CODING_AGENT_DIR` in slack-bridge settings loading, or provide a supported per-worker runtime-mode override, so child workers do not briefly attempt the global configured broker mode before `/pinet follow`.
- Decide how much of central broker RALPH/maintenance should run in worker-owned subtree brokers, and which signals should roll up to the central broker via the supervising worker.
