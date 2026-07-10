# @pinet/sonar

Sonar for the Pinet mesh. One read-only sweep of the broker database,
rendered as a single self-contained HTML datasheet.

The Pinet vision is invisible infrastructure: you mention an agent in Slack
and the right thing happens. Sonar is for the moments when you want to see
the infrastructure anyway — the pod of agents, the lanes they swim in, the
message traffic, and the duty roster of assignments, wakeups, and leases.

## What a sweep shows

- **§01 Pod** — every registered agent: status, liveness (heartbeat age),
  supervision state, threads owned.
- **§02 Traffic** — hourly message histogram for the trailing 24 hours,
  totals by source and direction, busiest threads.
- **§03 Lanes** — lane counts by state and the open lanes with owners and
  crew sizes.
- **§04 Threads** — the most recently active threads and who owns them.
- **§05 Duty roster** — open task assignments, unrouted backlog, scheduled
  wakeups, and active port leases.

The page is two inks on white, system fonts, zero external requests. It
never writes to the broker database: the connection is opened read-only.

## CLI

```bash
pinet-sonar                  # sweep ~/.pi/pinet-broker.db → ~/.pi/pinet-sonar.html
pinet-sonar --open           # sweep and open the datasheet
pinet-sonar --json           # print the snapshot as JSON to stdout
pinet-sonar --db /path/x.db --out /tmp/sweep.html
```

From a repo checkout it also runs straight from source:

```bash
node pinet-sonar/sonar-bin.ts --open
```

## Pi command

Installing the package as a pi extension registers one command:

```
/sonar             # sweep and open the datasheet
/sonar --db <path> --out <path>
```

## Design notes

- Zero npm runtime dependencies: `node:sqlite` reads the broker database
  directly, and the renderer emits a static HTML string.
- The snapshot layer (`snapshot.ts`) is decoupled from the renderer
  (`render.ts`); `--json` exposes the raw snapshot for agents and scripts.
- Missing tables are tolerated, so a sweep works against older broker
  schemas.
- One animation (the sonar dial) and it respects `prefers-reduced-motion`.
