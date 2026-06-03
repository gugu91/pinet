# @gugu910/pi-pinet-web-control-plane

Optional read-only web control plane for local Pinet broker operations.

This package is a **separate Pi extension** from `@gugu910/pi-slack-bridge`. Installing or enabling Slack/Pinet does not automatically expose an HTTP dashboard. The web control plane starts only when this package is installed as an extension and explicitly enabled in settings.

## Settings

Add a separate `pinet-web-control-plane` block to `~/.pi/agent/settings.json`:

```json
{
  "pinet-web-control-plane": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 17771,
    "username": "pinet",
    "passwordEnv": "PINET_WEB_CONTROL_PLANE_PASSWORD"
  }
}
```

Then provide the Basic Auth password out of band:

```bash
export PINET_WEB_CONTROL_PLANE_PASSWORD="change-me"
```

| Key           | Required | Description                                                                                                |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `enabled`     | yes      | Must be `true` to start the extension; default is disabled                                                 |
| `host`        | no       | Loopback-only bind host (`127.0.0.1`, `::1`, or `localhost`); defaults to `127.0.0.1`                      |
| `port`        | no       | Local listen port; defaults to `17771`; `0` selects an ephemeral port                                      |
| `username`    | no       | Basic Auth username; defaults to `pinet` or `PINET_WEB_CONTROL_PLANE_USERNAME`                             |
| `password`    | no       | Inline Basic Auth password; prefer `passwordEnv` for local use                                             |
| `passwordEnv` | no       | Environment variable that contains the Basic Auth password; defaults to `PINET_WEB_CONTROL_PLANE_PASSWORD` |
| `dbPath`      | no       | Broker SQLite database path; defaults to the normal Pinet broker DB path                                   |

## Routes

Authenticated `GET`/`HEAD` only:

- `/` — auto-refreshing HTML dashboard
- `/api/dashboard` / `/dashboard.json` — JSON dashboard
- `/healthz` — liveness response

Other HTTP methods return `405 Method Not Allowed` with `Allow: GET, HEAD`.

## Security posture

This is a first-cut local operations dashboard:

- disabled by default
- separate package and extension from Slack bridge
- loopback-only; non-loopback bind hosts are rejected
- Basic Auth required
- read-only HTTP routes only
- no process-control endpoints
- no Slack tokens, mesh secrets, prompt text, message bodies, lane summaries, snooze reasons, or raw free-text control data
- dashboard strings are HTML-escaped and redacted for common Slack/app/Bearer/JSON/env token-shaped secrets

If you need LAN or remote access, put this behind a trusted local tunnel or reverse proxy with stronger authentication rather than binding the extension directly to a non-loopback interface.
