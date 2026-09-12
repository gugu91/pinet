# @pinet/work

Independent, authenticated Markdown projects and tasks. It has no Chat, Slack, PM, status, assignment, dependency, nesting, revision, or workflow dependency.

```bash
pnpm --dir work build
PINET_WORK_TOKENS='["replace-with-a-high-entropy-token"]' \
PINET_WORK_DB="$HOME/.pi/agent/pinet-work.sqlite" node work/dist/cli.js
```

Set `PINET_WORK_URL` and `PINET_WORK_TOKEN` for the Pi extension. Call `pinet_work` with `action: "help"` for the compact action catalogue.

Updates replace the complete Markdown body. Concurrent updates are last-write-wins; timestamps are metadata, not revision guards. Deleting a project deletes its tasks. Search and list responses are bounded and paginated.

For Cloudflare, `cloudflare.ts` exports a Worker and `WorkDurableObject`. Bind `WORK`, store `PINET_WORK_TOKENS` as an encrypted JSON-array secret, and use `x-pinet-workspace` to select a workspace DO. Cloud deployment was not performed.
