/**
 * @pinet/amp-worker — Amp harness worker for the Pinet mesh.
 *
 * Public API surface. The CLI entry point lives in ./cli.ts (exposed via the
 * `pinet-amp-worker` bin); everything here is importable for embedding or
 * testing.
 */

export {
  AMP_MODES,
  parseAmpMode,
  AmpRunner,
  type AmpMode,
  type AmpExecutionResult,
  type AmpRunnerOptions,
} from "./amp-runner.js";
export { AmpStreamParser, type AmpResultEvent, type AmpStreamOutcome } from "./amp-stream.js";
export {
  AMP_WORKER_ADAPTER,
  buildAmpWorkerCapabilities,
  type AmpWorkerCapabilities,
  type AmpWorkerSubtreeCapability,
} from "./capabilities.js";
export {
  AMP_WORKER_USAGE,
  DEFAULT_POLL_INTERVAL_MS,
  parseAmpWorkerArgs,
  resolveAmpWorkerConfig,
  type AmpWorkerCliArgs,
  type AmpWorkerConfig,
  type AmpWorkerConfigEnv,
  type AmpWorkerConnectTarget,
} from "./config.js";
export {
  AMP_ORB_OIDC_ISSUER,
  captureAmpOrbIdentity,
  decodeAmpOrbIdentityToken,
  type AmpOrbIdentity,
} from "./orb-identity.js";
export {
  AmpWorkerStateStore,
  type AmpJobOutcome,
  type AmpJobPhase,
  type AmpJobRecord,
} from "./state-store.js";
export {
  AmpWorker,
  StateCommitError,
  buildAmpPrompt,
  buildReplyText,
  type AmpWorkerBrokerPort,
  type AmpWorkerOptions,
  type AmpWorkerRunnerPort,
} from "./worker.js";
export { AMP_WORKER_VERSION, buildAmpWorkerRegistrationMetadata, runAmpWorkerCli } from "./cli.js";
