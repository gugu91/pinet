# @pinet/work

Independent, authenticated Markdown projects and tasks. It has no Chat, Slack, PM, status, assignment, dependency, nesting, revision, or workflow dependency.

```bash
pnpm --dir work build
PINET_WORK_TOKENS='["replace-with-a-high-entropy-token"]' \
PINET_WORK_DB="$HOME/.pi/agent/pinet-work.sqlite" node work/dist/cli.js
```

The Node daemon listens on `127.0.0.1:8788` by default. Set `HOST` only when intentionally exposing it through a trusted network or reverse proxy. Set `PINET_WORK_URL` and `PINET_WORK_TOKEN` for the Pi extension. Call `pinet_work` with `action: "help"` for the compact action catalogue.

Updates replace the complete Markdown body. Concurrent updates are last-write-wins; timestamps are metadata, not revision guards. Deleting a project deletes its tasks. Search and list responses are bounded and paginated.

Requests must use `application/json`. Request bodies are limited to 64 KiB, Markdown fields to 32,768 characters, identifiers to 128 characters, external channel names to 256 characters, and search queries to 256 characters. Internal storage errors are not returned to callers.

For Cloudflare, `cloudflare.ts` exports a Worker and `WorkDurableObject`. Bind `WORK` and store `PINET_WORK_TOKENS` as an encrypted JSON-array secret. A deployment is intentionally one collaborative workspace: every valid agent token can access the same data. Callers cannot select a namespace with `x-pinet-workspace`; operators may set the server-side `PINET_WORKSPACE` binding to a stable Durable Object name. Authentication occurs in the Worker before Durable Object allocation, and credentials remain Worker-side. Cloud deployment was not performed.
