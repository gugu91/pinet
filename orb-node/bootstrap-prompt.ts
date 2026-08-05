/**
 * Bootstrap prompt for launching a Pinet broker node in a fresh Amp orb.
 *
 * `pinet-orb-node up` passes this prompt to `amp --orb-execute
 * --no-archive-after-execute -x ...`; the orb agent then runs the idempotent
 * setup script from the repository checkout. Keeping the prompt a pure
 * function makes the launch contract testable and reviewable as text.
 */

export interface BrokerOrbBootstrapOptions {
  /** Supervised service + tmux session name. Default: "pinet-broker". */
  serviceName?: string;
}

export const DEFAULT_BROKER_SERVICE_NAME = "pinet-broker";

export function buildBrokerOrbBootstrapPrompt(options: BrokerOrbBootstrapOptions = {}): string {
  const serviceName = options.serviceName ?? DEFAULT_BROKER_SERVICE_NAME;
  return `You are bootstrapping this orb as a Pinet mesh broker node (Phase 1: broker plus colocated workers in this orb; design in plans/amp-orbs-as-mesh-nodes.md).

From the repository root, run:

    PINET_ORB_SERVICE_NAME=${serviceName} bash orb-node/setup/orb-broker-setup.sh

The script is idempotent. It installs the pinet-orb-node Amp plugin (webhook wake channel + orb keepAlive), restarts the Amp executor service to load it, installs the pi CLI when missing, and starts the supervised broker service "${serviceName}" (pi inside a tmux session, wrapped by amp orb service). Restarting the executor may briefly disconnect your session; when you reconnect, re-run the script — completed steps are skipped.

Verify all of the following before reporting:
1. ~/.pinet/orb-node/webhook.json exists and contains a capability URL.
2. ~/.pinet/orb-node/status.json shows "keepAlive":"held".
3. 'amp orb service status ${serviceName}' shows the service active (running).
4. 'tmux has-session -t ${serviceName}' exits 0.

Then report: the webhook capability URL (it is a bearer credential — report it only inside this thread, never to logs or commits), the status.json contents, the service status, and 'pi --version' output.

Constraints: do NOT commit or push anything, do NOT archive this thread, do NOT print secret values other than the capability URL, and stay idle after reporting so the keepAlive lease is what keeps this orb awake.`;
}
