# Worker keys

A worker key lets a Pi session join your broker as a named worker, with its own credential that you can revoke. Use one for workers that run outside the broker's shell: in a Rex block, under tmux or Herdr, or on another machine.

Workers with a key are trusted collaborators. They can message other agents, work on threads and lanes, and make Slack calls through the broker. They cannot:

- run broker admin commands, such as shutting the broker down or managing keys
- send `/exit`, `/reload` or other control commands to the broker (the broker ignores them)
- attach files by path, which the broker would read from its own disk
- search session records, or claim another identity or broker-managed status

The design and its limits are in [`plans/worker-membership.md`](../../plans/worker-membership.md).

## Before you start

The broker needs a mesh secret (see [Mesh authentication](../README.md#mesh-authentication)). A broker refuses to issue keys without one, and refuses to start if keys exist but the secret has been removed.

## Issue a key

`pinet-worker` is on your PATH when the package is installed with npm. With a Pi git install, run it as `node ~/.pi/agent/git/github.com/gugu91/pinet/slack-bridge/dist/worker-cli.js` instead.

On the broker's machine, with the broker running:

```sh
pinet-worker issue --host studio --worker w1 \
  --join-socket ~/.pi/pinet.sock --out ~/.pi/agent/pinet/w1.join.json
```

- `--host` and `--worker` name the worker. Use lowercase letters, digits and `-`. The worker registers as `studio:worker:w1`.
- `--join-socket` is the socket path the worker will connect to. On the broker's own machine that is the broker socket. For another machine, see below.
- `--out` gets an owner-only join file. The command never prints the key, and it will not overwrite an existing file.

Issuing again for the same worker rotates the key: the old key stops working and its connection closes.

## Start a worker

```sh
pi --pinet-join ~/.pi/agent/pinet/w1.join.json
```

Any launcher works, for example:

```sh
rex run --focus=false --cwd ~/projects/pinet -- pi --pinet-join ~/.pi/agent/pinet/w1.join.json
```

The worker follows the broker at startup and needs no Slack tokens. The join file must be readable only by you (`chmod 600`). There is deliberately no environment variable for this, so child `pi` processes do not join under the parent's key.

## Workers on another machine

Pinet does not listen on the network. Forward a local socket on the worker's machine to the broker's socket over SSH:

```sh
mkdir -m 700 -p ~/.pi/pinet-remote
ssh -N -o ExitOnForwardFailure=yes -o StreamLocalBindUnlink=yes \
  -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  -L ~/.pi/pinet-remote/broker.sock:/Users/you/.pi/pinet.sock broker-mac
```

Issue the key with `--join-socket ~/.pi/pinet-remote/broker.sock` (the path on the worker's machine), copy the join file there with `chmod 600`, and start the worker with `--pinet-join`.

- Keep the tunnel running with launchd or `autossh`, one tunnel per socket path.
- If the broker restarts, the worker reconnects through the same tunnel.
- OpenSSH over Tailscale is the simplest setup between Macs.
- SSH access is broader than Pinet access. A key that can forward to the broker socket can forward to any other socket or port the broker's user can reach, and can read the mesh secret if it can log in. `restrict,port-forwarding,command="/usr/bin/false"` in `authorized_keys` prevents a shell but does not limit forwarding. Revoking a worker key does not revoke SSH access.

## Revoke and list

```sh
pinet-worker revoke --host studio --worker w1
pinet-worker list
```

Revoking closes the worker's connection at once, and the worker stops trying to reconnect. Work already in progress, such as a Slack call already sent, may still finish. The worker's process keeps running until you stop it.

`list` shows each worker, when its key was created or revoked, and whether it is connected. It never shows keys.
