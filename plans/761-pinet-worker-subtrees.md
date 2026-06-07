# #761 Pinet worker subtrees implementation note

This branch implements worker-owned Pinet subtrees end to end.

## End-to-end behavior

- A normal Pinet follower worker can run `/pinet subtree start` while remaining connected to the central broker.
- The worker starts a separate local broker socket/database under `~/.pi/pinet-subtrees/<worker>/` and registers itself inside that local broker as `subbroker-<worker>`.
- Child workers launched by that worker receive `PINET_SOCKET_PATH` plus parent/root/launch/role/lane metadata, so they follow the worker-owned subtree broker rather than `~/.pi/pinet.sock`.
- `pinet action=spawn` now launches a real tmux-backed child worker, waits for registration in the subtree broker DB, and delivers the task over Pinet A2A.
- `/pinet subtree spawn repo=<repo> [role=<role>] [lane=<lane>] <task>` provides the same flow from the slash-command surface.
- The supervising worker can inspect child roster with `pinet action=agents args.scope=subtree args.full=true`, read child reports with `pinet action=read`, reply/control children with `pinet action=send`, and ask children to exit with `pinet action=exit`.
- `/pinet subtree stop` asks spawned children to exit, then cleans up known tmux sessions and stops the local subtree broker.
- The central broker sees only the supervising worker. The subtree DB contains the child workers and their messages.

## Implementation notes

- Broker registration still stores typed hierarchy metadata: parent/root ids, tree depth, spawned-by audit, supervision state, launch id, subtree role, and lane id.
- `follower-runtime.ts` honors `PINET_SOCKET_PATH`, letting children connect to a worker-owned broker socket.
- `runtime-mode.ts` treats `PINET_BROKER_MANAGED=1` plus `PINET_LAUNCH_SOURCE=subtree-broker-tmux` or an explicit `PINET_SOCKET_PATH` as a managed follower launch, preventing child sessions from trying to become the global broker just because persistent settings request broker mode.
- `subtree-broker-runtime.ts` owns the local broker, tmux launch, child registration wait, task delivery, roster/read/send routing, and cleanup.
- `pinet-tools.ts` routes follower-owned `send`, `read`, `agents scope=subtree`, `spawn`, `reload`, and `exit` through the active subtree broker where applicable, falling back to the central broker for normal follower work.

## E2E smoke result

A manual tmux smoke on 2026-05-26 verified the full workflow with isolated temp HOME/agent dirs and the active local package cache extension:

- Central broker started with `/pinet start`.
- Parent worker followed central with `/pinet follow` and started `/pinet subtree start`.
- Parent launched a real child through `/pinet subtree spawn repo=/Users/thomasmustier/extensions role=smoke lane=smoke-761 <task>`.
- Child registered only in the subtree DB as a supervised child, not in the central broker DB.
- Child read the task, sent `E2E smoke child report from spawned worker` back to the subbroker, and parent read the full report body through `pinet action=read`.
- Parent sent an acknowledgement back to the child.
- `/pinet subtree stop` asked the child to exit, removed the spawned child tmux session, and stopped the subtree broker socket.

Detailed evidence is in `.research/761-pinet-worker-subtree-e2e.md`.

## Verification to keep current

Run these before merging:

```bash
pnpm --filter @gugu910/pi-slack-bridge lint
pnpm --filter @gugu910/pi-slack-bridge typecheck
pnpm --filter @gugu910/pi-slack-bridge test -- pinet-tools.test.ts pinet-commands.test.ts runtime-mode.test.ts
pnpm --filter @gugu910/pi-slack-bridge build
```

Manual smoke should prove:

1. Parent follower starts `/pinet subtree start`.
2. Parent runs `pinet action=spawn` or `/pinet subtree spawn ...`.
3. Child registers in the subtree DB only, not the central broker DB.
4. Child reports to parent; parent reads the report with `pinet action=read`.
5. Parent replies or sends `/reload`/`/exit` to the child through the subtree broker.
6. `/pinet subtree stop` cleans up child tmux sessions and stops the local broker.
