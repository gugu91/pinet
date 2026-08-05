#!/usr/bin/env bash
# Idempotent orb-side bootstrap for a Pinet broker node (Phase 1).
#
# Run from the repository root inside an Amp orb:
#
#     PINET_ORB_SERVICE_NAME=pinet-broker bash orb-node/setup/orb-broker-setup.sh
#
# Steps (each skipped when already done):
#   1. Install the pinet-orb-node Amp plugin (webhook wake channel + keepAlive)
#      to ~/.config/amp/plugins/ and write its config.
#   2. Restart the Amp executor service so the plugin loads, then wait for the
#      webhook registration file. This step may briefly disconnect the agent
#      turn that runs this script; the script is safe to re-run.
#   3. Install the pi CLI when missing.
#   4. Write minimal pi broker settings when none exist (runtimeMode=broker;
#      Slack tokens are taken from PINET_SLACK_BOT_TOKEN/PINET_SLACK_APP_TOKEN
#      and the Slack access allowlist from PINET_SLACK_ALLOWED_USERS
#      (comma-separated user IDs — include your own) when present, e.g. via
#      Amp project secrets/env vars. Without an allowlist the broker starts
#      default-deny and ignores all Slack users.
#   5. Start the supervised broker service: pi in a tmux session, wrapped in a
#      foreground supervisor for `amp orb service`.
#
# Secrets policy: the webhook capability URL and Slack tokens are written 0600
# under $HOME and never echoed by this script.
set -euo pipefail

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PLUGIN_SRC="$SCRIPT_DIR/../plugin.ts"
PLUGIN_DEST="$HOME/.config/amp/plugins/pinet-orb-node.ts"
CONFIG_PATH="$HOME/.config/pinet-orb-node.json"
STATE_DIR="$HOME/.pinet/orb-node"
WEBHOOK_JSON="$STATE_DIR/webhook.json"
PI_SETTINGS="$HOME/.pi/agent/settings.json"
SERVICE_NAME="${PINET_ORB_SERVICE_NAME:-pinet-broker}"
RUN_SCRIPT="$STATE_DIR/run-broker.sh"

step() { printf '\n== %s\n' "$1"; }

step "directories"
mkdir -p "$STATE_DIR" "$HOME/.config/amp/plugins" "$HOME/.pi/agent"
chmod 700 "$STATE_DIR"

step "plugin install"
plugin_changed=0
if ! cmp -s "$PLUGIN_SRC" "$PLUGIN_DEST" 2>/dev/null; then
  cp "$PLUGIN_SRC" "$PLUGIN_DEST"
  plugin_changed=1
  echo "installed $PLUGIN_DEST"
else
  echo "plugin already up to date"
fi

step "plugin config"
if [ ! -f "$CONFIG_PATH" ]; then
  umask 077
  printf '{"role":"broker","keepAlive":true}\n' > "$CONFIG_PATH"
  plugin_changed=1
  echo "wrote $CONFIG_PATH"
else
  echo "config already present"
fi

step "load plugin (amp executor restart)"
if [ "$plugin_changed" -eq 1 ] || [ ! -f "$WEBHOOK_JSON" ]; then
  echo "restarting amp-headless.service to load the plugin..."
  sudo systemctl restart amp-headless.service
else
  echo "webhook already registered; skipping restart"
fi

step "wait for webhook registration"
deadline=$((SECONDS + 90))
until [ -f "$WEBHOOK_JSON" ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "ERROR: $WEBHOOK_JSON did not appear within 90s." >&2
    echo "Check plugin logs (amp-headless journal) and re-run this script." >&2
    exit 1
  fi
  sleep 2
done
echo "webhook registered ($WEBHOOK_JSON present; URL is a credential, not echoed)"

step "pi CLI"
if ! command -v pi >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/pi" ]; then
  curl -fsSL https://pi.dev/install.sh | sh
fi
# The installer's PATH edits only reach login shells; resolve an absolute path
# so the systemd-spawned service wrapper below works regardless of PATH.
PI_BIN=$(command -v pi || true)
if [ -z "$PI_BIN" ] && [ -x "$HOME/.local/bin/pi" ]; then
  PI_BIN="$HOME/.local/bin/pi"
fi
if [ -z "$PI_BIN" ]; then
  echo "ERROR: pi not found after install; check https://pi.dev install output." >&2
  exit 1
fi
echo "pi: $PI_BIN ($("$PI_BIN" --version 2>/dev/null || echo '?'))"

step "pi broker settings"
if [ -f "$PI_SETTINGS" ]; then
  echo "settings already present; leaving untouched"
else
  umask 077
  node -e '
    const settings = { "slack-bridge": { runtimeMode: "broker" } };
    const bot = process.env.PINET_SLACK_BOT_TOKEN;
    const app = process.env.PINET_SLACK_APP_TOKEN;
    if (bot) settings["slack-bridge"].botToken = bot;
    if (app) settings["slack-bridge"].appToken = app;
    const allowed = (process.env.PINET_SLACK_ALLOWED_USERS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    if (allowed.length > 0) settings["slack-bridge"].allowedUsers = allowed;
    process.stdout.write(JSON.stringify(settings, null, 2) + "\n");
  ' > "$PI_SETTINGS"
  if [ -n "${PINET_SLACK_BOT_TOKEN:-}" ] && [ -n "${PINET_SLACK_APP_TOKEN:-}" ]; then
    echo "wrote $PI_SETTINGS (runtimeMode=broker, Slack tokens from env)"
  else
    echo "wrote $PI_SETTINGS (runtimeMode=broker, NO Slack tokens in env — Slack stays off)"
  fi
  if [ -n "${PINET_SLACK_ALLOWED_USERS:-}" ]; then
    echo "allowedUsers set from PINET_SLACK_ALLOWED_USERS"
  else
    echo "no PINET_SLACK_ALLOWED_USERS — Slack access stays default-deny"
  fi
fi

step "broker run script"
umask 077
cat > "$RUN_SCRIPT" <<RUNEOF
#!/usr/bin/env bash
# Foreground supervisor for 'amp orb service': keeps the service active while
# the pi broker tmux session lives; exits nonzero when it dies so systemd
# restarts the service and recreates the session.
set -euo pipefail
SESSION="$SERVICE_NAME"
tmux has-session -t "\$SESSION" 2>/dev/null || tmux new-session -d -s "\$SESSION" -x 200 -y 50 "$PI_BIN"
while tmux has-session -t "\$SESSION" 2>/dev/null; do sleep 5; done
exit 1
RUNEOF
chmod 700 "$RUN_SCRIPT"
echo "wrote $RUN_SCRIPT"

step "broker service"
amp orb service start "$SERVICE_NAME" --command "bash $RUN_SCRIPT"
amp orb service status "$SERVICE_NAME" || true

step "summary"
echo "webhook registration: $WEBHOOK_JSON"
echo "plugin status:        $STATE_DIR/status.json"
echo "wake events log:      $STATE_DIR/webhook-events.jsonl"
echo "broker service:       $SERVICE_NAME (tmux session: $SERVICE_NAME)"
echo "done"
