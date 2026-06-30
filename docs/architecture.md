---
layout: default
title: Architecture
---

# Architecture

How Pinet coordinates multiple agents through Slack.

## System design

### Core components

Pinet has three main parts:

1. Socket Mode connection - real-time link to Slack
2. Message router - sends work to the right agent
3. State manager - tracks threads, ownership, and inbox

### Runtime modes

Pinet runs in three modes:

- single - one instance does everything
- broker - coordinates and routes messages
- follower - receives work from broker

Most users need only single mode. Large deployments use broker and followers.

## Broker architecture

### What the broker does

The broker is the coordinator. It:

- maintains the Socket Mode connection
- receives all Slack events
- assigns work to agents
- tracks thread ownership
- syncs state to followers
- runs the RALPH maintenance loop

### Broker state

The broker keeps track of:

- active agents and their status
- thread ownership mapping
- inbox messages per agent
- lane assignments
- scheduled wake-ups

### State persistence

State is stored in:

- SQLite for inbox and threads
- memory for active connections
- Slack for thread history

State survives broker restarts but not follower restarts.

## Follower architecture

### What followers do

Followers are workers. They:

- connect to the broker through the configured broker transport
- receive assigned messages
- process their inbox
- report status back
- stay in sync automatically

### Follower connection

By default, broker and follower communication uses the local Pinet socket at `~/.pi/pinet.sock`. A broker can also use an explicit TCP listener when you configure one.

The connection uses:

- JSON message framing
- optional shared-secret auth
- automatic reconnection
- heartbeat keep-alive

### Message flow

1. Slack sends event to broker
2. Broker checks thread ownership
3. Broker routes to correct agent
4. Agent processes message
5. Agent sends response through broker
6. Broker sends to Slack

## RALPH maintenance loop

### Purpose

RALPH (Routing, Assignment, Lifecycle, Presence, Health) keeps the system healthy.

### What RALPH does

Every 5 minutes, RALPH:

1. Checks worker presence
2. Expires stale broker state
3. Clears orphaned thread claims
4. Observes pending backlog while broker maintenance handles assignment
5. Triggers scheduled wake-ups
6. Compacts the inbox

### Stall detection

Work may need attention when:

- a worker has disappeared
- a thread owner is no longer available
- pending backlog is not draining
- a scheduled wake-up is due

### Recovery actions

RALPH recovers by:

- releasing claims held by unavailable workers
- reporting pending backlog so broker maintenance can assign it
- nudging work that needs attention
- alerting through the configured status path

## Thread ownership

### How ownership works

When an agent first responds in a thread, it owns that thread. All future messages in the thread go to that agent.

### Ownership transfer

Ownership changes when:

- a thread is explicitly claimed by another worker
- the current owner becomes unavailable and the broker clears the stale claim
- the thread claim expires according to broker state rules

### Thread lifecycle

1. User starts a thread
2. Broker checks allowlists and thread control rules
3. Broker routes to an existing owner, an explicit hint, a channel assignment, or an agent mention
4. Worker responds and may claim the thread
5. Thread claim is kept until it is released, replaced, or expires

## Message routing

### Routing rules

Messages are routed by:

1. Access allowlist and explicit thread controls
2. Existing thread owner, when that worker is available
3. Explicit worker hint
4. Channel assignment
5. Agent mention
6. `unrouted`, when no route applies

### New work

New work is not automatically load-balanced. Configure channel assignments, mention a worker, or use broker controls to route work deliberately.

### Priority messages

High priority messages:

- direct mentions
- slash commands
- error recovery
- scheduled wake-ups

These jump the queue in the inbox.

## Inbox system

### What the inbox stores

Each agent has an inbox containing:

- unread messages
- thread context
- scheduled tasks
- deferred work

### Inbox processing

Agents process their inbox:

1. Read oldest unread message
2. Load thread context
3. Generate response
4. Mark as read
5. Repeat

### Inbox limits

Default limits:

- 1000 messages per agent
- 30 days retention
- 10MB per message
- compact when 80% full

## State synchronisation

### Broker to follower sync

The broker sends:

- inbox updates
- ownership changes
- configuration updates
- presence broadcasts

### Follower to broker sync

Followers send:

- status updates
- read receipts
- error reports
- heartbeats

### Conflict resolution

When conflicts occur:

- broker state wins
- timestamps break ties
- RALPH fixes inconsistencies

## Security architecture

### Authentication

Three levels:

1. Slack tokens - app and bot tokens
2. User allowlist - who can use Pinet
3. Mesh secret - broker-follower auth

### Authorisation

Checks happen at:

- Slack event receipt
- command execution
- tool invocation
- state modification

### Isolation

Agents are isolated by:

- separate inboxes
- thread ownership
- lane assignment
- permission scopes

## Performance characteristics

### Throughput

Typical limits:

- 1 message/second per channel
- 20 messages/minute workspace
- 100 concurrent threads
- 10 followers per broker

### Latency

Expected times:

- Slack to broker: 50-200ms
- broker routing: 10-50ms
- follower sync: 100-500ms
- full round trip: 200-1000ms

### Scalability

Scales by:

- adding followers (horizontal)
- increasing RALPH frequency
- adjusting inbox limits
- routing configuration

## Failure modes

### Broker failure

When the broker fails:

- followers continue current work
- new messages queue in Slack
- RALPH stops running
- state stops syncing

Recovery: restart broker or promote follower.

### Follower failure

When a follower fails:

- its active claims can become stale
- RALPH can release stale claims after health checks
- other followers continue their current work
- new messages route only when a valid owner, hint, assignment, or mention applies

Recovery: restart the follower, clear stale claims, or route the work to another available worker.

### Network partition

If network splits:

- followers reconnect automatically
- messages queue until reconnection
- state resyncs on reconnect
- duplicates are prevented

### Slack outage

During Slack outage:

- Socket Mode reconnects automatically
- messages queue locally
- sent when connection returns
- no message loss

## Extension points

### Adding tools

New tools register with:

```javascript
pi.registerTool("tool_name", {
  // tool configuration
});
```

### Custom routing

Adapt routing with current broker controls:

- explicit thread control
- channel assignments
- worker hints
- agent mentions

### State backends

Pluggable storage for:

- inbox (default: SQLite)
- ownership (default: memory)
- configuration (default: file)
