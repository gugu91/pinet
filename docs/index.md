---
layout: default
title: Pinet documentation
---

# Pinet documentation

Get Pinet working in your Slack workspace in 10 minutes.

## Quick start

1. [Install Pinet](setup.md) - set up the Slack app and configure tokens
2. [Configure access](configuration.md#control-access) - decide who can use Pinet
3. [Use Pinet](usage.md) - send messages and run commands

## What Pinet is

Pinet connects pi coding agents to Slack. It coordinates multiple agents, routes messages, and keeps track of work.

The system can:

- respond to Slack messages
- coordinate agents working on different tasks
- review pull requests automatically
- recover from failures
- keep you informed about progress

## Core concepts

### Broker and workers

One agent acts as the broker. It watches Slack, routes messages, and keeps worker state in sync. Worker agents pick up tasks, write code, and open pull requests.

### Self-repair

The RALPH loop checks worker presence every 5 minutes. It releases stale claims, observes pending backlog, and triggers scheduled wake-ups. Broker maintenance handles backlog assignment.

### Agent identity

Named agents like 'Rocket Dolphin' make it easy to see who is doing what.

## Documentation

- [Setup guide](setup.md) - install and configure Pinet
- [Configuration](configuration.md) - all settings explained
- [Usage](usage.md) - how to use Pinet
- [Architecture](architecture.md) - how Pinet works
- [Troubleshooting](troubleshooting.md) - fix common problems
- [API reference](reference.md) - tool and action documentation

## Get help

- Check the [troubleshooting guide](troubleshooting.md)
- Use `/pinet logs` or check your configured Slack log channel
- Visit the [GitHub repository](https://github.com/gugu91/extensions)
