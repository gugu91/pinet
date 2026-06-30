# Extensions

Get Pinet working in your Slack workspace in 10 minutes. This repository provides pi coding agent extensions for Slack, Neovim, and Neon Postgres.

## What Pinet does

Pinet connects pi coding agents to Slack. It runs a broker that coordinates work, routes messages, and keeps multiple agents working together. The system can:

- respond to Slack messages and commands
- coordinate multiple agents working on different tasks
- support pull request review workflows
- recover from stale claims and surface pending backlog
- keep you informed about what agents are doing

## Get started

### Install from npm

Install the Slack bridge package:

```bash
pi install npm:@pinet/slack-bridge
```

Or pin a specific version:

```bash
pi install npm:@pinet/slack-bridge@0.2.2
```

### Set up your Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app
2. Choose 'From a manifest'
3. Select your workspace
4. Paste the contents of [`slack-bridge/manifest.yaml`](slack-bridge/manifest.yaml)
5. Create the app

### Get your tokens

You need two tokens from Slack:

- App-Level Token: go to Basic Information → App-Level Tokens → Generate (add `connections:write` scope)
- Bot Token: go to OAuth & Permissions → Install to Workspace → copy the Bot User OAuth Token

### Configure Pinet

Add your tokens, runtime mode, and access rules to `~/.pi/agent/settings.json`:

```json
{
  "slack-bridge": {
    "botToken": "xoxb-your-bot-token",
    "appToken": "xapp-your-app-token",
    "runtimeMode": "single",
    "allowedUsers": ["U_YOUR_USER_ID"]
  }
}
```

Start pi. Pinet appears in your Slack sidebar.

## Current features

The repository includes these extensions:

| Package                                     | Description                                             |
| ------------------------------------------- | ------------------------------------------------------- |
| [`transport-core`](transport-core/)         | Message contracts shared across transport packages      |
| [`browser-playwright`](browser-playwright/) | Browser automation with Playwright                      |
| [`slack-bridge`](slack-bridge/)             | Slack integration with broker mesh, inbox, and canvases |
| [`slack-api`](slack-api/)                   | Typed Slack Web API client                              |
| [`imessage-bridge`](imessage-bridge/)       | macOS iMessage transport                                |
| [`nvim-bridge`](nvim-bridge/)               | Neovim editor context sync                              |
| [`neon-psql`](neon-psql/)                   | Neon Postgres tunnel                                    |
| [`types`](types/)                           | Shared type declarations                                |

Recent updates include:

- broker mesh for coordinating multiple agents
- Slack canvases, uploads, modals, bookmarks, and pins
- scheduled wake-ups and inbox sync
- browser automation with reusable sessions
- optional shared-secret mesh authentication

## How Pinet works

### Architecture

Pinet uses a broker-worker model. One agent acts as the broker. It watches Slack, assigns work, and keeps track of what each worker is doing. Worker agents pick up tasks, write code, run tests, and open pull requests.

The system can review its own code. Agents review each other's pull requests, handle rebases, and fix broken branches when the main branch moves.

### Self-repair

The RALPH loop monitors broker health. It:

- checks worker presence every 5 minutes
- releases stale thread claims when owners disappear
- observes pending backlog while broker maintenance handles assignment
- triggers scheduled wake-ups

### Agent identity

Named agents make the system easier to follow. When you see 'Rocket Dolphin' or 'Silent Crocodile' in Slack, you know which agent is working on what. This helps when dozens of tasks are moving at once.

## Development

### Work in a git worktree

Never work directly on main. Create a worktree for your changes:

```bash
git worktree add .worktrees/my-feature -b feat/my-feature
cd .worktrees/my-feature
pnpm install --frozen-lockfile
```

### Run checks

```bash
pnpm lint         # ESLint
pnpm typecheck    # TypeScript
pnpm test         # Vitest
pnpm prepush      # All checks (runs on git push)
```

### Structure

```
extensions/
├── transport-core/       # Message contracts
├── browser-playwright/   # Browser automation
├── slack-bridge/         # Slack integration
├── slack-api/           # Slack API client
├── imessage-bridge/     # iMessage transport
├── nvim-bridge/         # Neovim sync
├── neon-psql/          # Postgres tunnel
├── types/              # Type declarations
├── plans/              # Architecture docs
├── .pi/                # Pi configuration
├── turbo.json          # Build orchestration
└── package.json        # Root configuration
```

### Local development

For development, link extensions directly:

```bash
ln -s "$(pwd)/slack-bridge" ~/.pi/agent/extensions/slack-bridge
ln -s "$(pwd)/nvim-bridge" ~/.pi/agent/extensions/nvim-bridge
ln -s "$(pwd)/neon-psql" ~/.pi/agent/extensions/neon-psql
ln -s "$(pwd)/browser-playwright" ~/.pi/agent/extensions/browser-playwright
```

## Philosophy

### Built by the system it enables

Pinet was built by agents coordinating through Slack and GitHub. During development, the mesh merged over 50 pull requests in a single day with minimal human intervention.

The broker coordinates but does not write code. Workers ship end to end. They write code, add tests, run checks, push branches, and open pull requests. Agents review other agents' work. The mesh self-repairs when things break.

### Human leverage

Humans set priorities, approve merges, and provide API tokens. The system handles coordination and execution. The goal is to move humans up a level — from doing every step to steering a system that coordinates itself.

## Configuration reference

See [full configuration options](slack-bridge/README.md#configure-pinet) for all settings.

Key settings:

- `botToken` and `appToken`: required Slack tokens
- `allowedUsers`: limit access to specific Slack users
- `defaultChannel`: where Pinet posts updates
- `ralphLoopIntervalMs`: how often RALPH checks for stalls (default 5 minutes)
- `meshSecret` or `meshSecretPath`: optional shared-secret authentication

## Troubleshooting

### Pinet does not appear in Slack

Check that:

- both tokens are in your settings.json
- the Slack app is installed to your workspace
- pi is running

### Commands do not work

Check that:

- you are in the allowed users list (or `allowAllWorkspaceUsers` is true)
- the bot has the required scopes (see manifest.yaml)
- Socket Mode is enabled in your Slack app

### Agents get stuck

RALPH checks for stalls every 5 minutes by default. You can:

- reduce `ralphLoopIntervalMs` for faster recovery
- run `/pinet status` inside pi to check Pinet state
- use `/pinet logs` inside pi or check your configured log channel for errors

## Next steps

- Read the [Slack bridge documentation](slack-bridge/) for detailed configuration
- See [architecture plans](plans/) for design decisions
- Join the discussion in your Slack workspace

## Repository information

- GitHub: [github.com/gugu91/extensions](https://github.com/gugu91/extensions)
- License: MIT
- Package manager: pnpm with workspaces
- Build tool: Turborepo with local caching
- Node version: 22 or later
