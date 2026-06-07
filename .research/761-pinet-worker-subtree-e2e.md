# Pinet worker-owned subtree broker E2E smoke

Date: 2026-05-26
Branch: `feat/761-worker-subtree-broker-command`

## Setup

Smoke used isolated temp HOME and Pi agent dirs under `/tmp/pinet-subtree-e2e-000630`, with the active local package cache extension loaded from `/Users/thomasmustier/.pi/agent/git/github.com/gugu91/extensions/slack-bridge/index.ts`.

Sessions:

- Central broker: `pinet-subtree-e2e-000630-broker`
- Parent worker: `pinet-subtree-e2e-000630-parent`
- Spawned child: `pinet-extensions-smoke-7-no44s1`

Commands exercised:

1. Central: `/pinet start`
2. Parent: `/pinet follow`
3. Parent: `/pinet subtree start`
4. Parent: `/pinet subtree spawn repo=/Users/thomasmustier/extensions role=smoke lane=smoke-761 <task>`
5. Child: read task pointer and sent report through `pinet action=send`
6. Parent: read child report via `pinet action=read`
7. Parent: acknowledged child via `pinet action=send`
8. Parent: `/pinet subtree stop`

## Evidence

Central broker DB before cleanup contained only the broker and parent, no child:

```text
700203f8|The Broker Goose||0|root
23ea6a74-960c-4791-a75e-eb138d19bf7f|E2E Subtree Parent||0|root
```

Subtree broker DB contained the subbroker and child:

```text
subbroker-23ea6a74-960c-4791-a75e-eb138d19bf7f|Subtree Broker E2E Subtree Parent||0|root
9183aebf-4f54-442f-bc6c-53c7844700a4|Subtree smoke subtree-mpltg2k7-no44s1|subbroker-23ea6a74-960c-4791-a75e-eb138d19bf7f|1|supervised
```

Subtree messages showed task delivery, child report, and parent reply:

```text
1|a2a:subbroker-23ea6a74-960c-4791-a75e-eb138d19bf7f:9183aebf-4f54-442f-bc6c-53c7844700a4|subbroker-23ea6a74-960c-4791-a75e-eb138d19bf7f|Use the pinet dispatcher to send args.to="subbroker-23ea6a74-960c-4791-a75e-eb138d19bf7f" args.message="E2E smoke child report from spawned worker". Then wait.
2|a2a:9183aebf-4f54-442f-bc6c-53c7844700a4:subbroker-23ea6a74-960c-4791-a75e-eb138d19bf7f|9183aebf-4f54-442f-bc6c-53c7844700a4|E2E smoke child report from spawned worker
3|a2a:subbroker-23ea6a74-960c-4791-a75e-eb138d19bf7f:9183aebf-4f54-442f-bc6c-53c7844700a4|subbroker-23ea6a74-960c-4791-a75e-eb138d19bf7f|<parent acknowledgement>
```

Parent read output included the full child report body from the subtree broker:

```text
Pinet read (unread) from thread a2a:9183aebf-4f54-442f-bc6c-53c7844700a4:subbroker-23ea6a74-960c-4791-a75e-eb138d19bf7f: 1 message.
- [fwup] [agent/... #2] 9183aebf-4f54-442f-bc6c-53c7844700a4: E2E smoke child report from spawned worker
```

Cleanup evidence:

```text
Subtree broker stopped. Spawned child followers were asked to exit.
child sessions after cleanup: none
subtree socket after cleanup: socket stopped
```
