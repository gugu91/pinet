# #761 Pinet worker subtrees implementation note

This branch implements the safe staging layer for worker-owned Pinet subtrees.

## Implemented in this branch

- Adds typed agent hierarchy fields in the broker database: parent/root ids, tree depth, spawned-by audit, supervision state, launch id, subtree role, and lane id.
- Accepts hierarchy metadata during real Pinet follower registration, including env-derived metadata from broker-managed launches.
- Preserves the broker protocol boundary: supervised children are still normal broker-connected followers, but ordinary broadcasts/backlog assignment exclude supervised children.
- Adds subtree-aware A2A policy: parent/child/ancestor/descendant messages are allowed; unrelated workers cannot directly message supervised children; broker emergency overrides remain explicit.
- Adds lifecycle handling: child exit notifies its parent; parent unregister/reap/purge marks descendants orphaned and sends child orphan notices.
- Extends `pinet action=agents` with explicit `scope=children|subtree` plus hierarchy details in full output.
- Adds `pinet action=spawn` as a validation surface that returns a precise blocker until the #406 real follower launcher/bootstrap contract exists.

## Deliberate blocker

The branch does **not** start local Agent subagents. `pinet action=spawn` validates the requested child task/scope, then reports `missing_broker_connected_worker_launcher` because #406-style broker-connected worker bootstrap is not yet present as callable infrastructure. The returned details document the env contract a real launcher must provide (`PINET_PARENT_AGENT_ID`, `PINET_LAUNCH_ID`, subtree role/lane metadata, etc.).

## Next step after #406

Wire the validated `spawn` action to the real launcher, create a short-lived launch token, start a tmux/process-managed Pi follower with the returned hierarchy env, wait for registration, and then deliver the child task over private A2A.
