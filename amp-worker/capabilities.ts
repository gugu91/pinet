/**
 * Explicit, capability-negotiated feature surface for the Amp worker.
 *
 * The Pinet mesh treats capabilities as first-class registration metadata so
 * brokers and peers never have to guess what a harness supports. Anything Amp
 * cannot do is advertised as unavailable with a reason instead of being
 * silently second-class — most notably subtree spawning: Amp's cross-thread
 * child tools are prompt-driven inside Amp itself and there is no
 * broker-callable child-thread API, so `subtree.spawn` is `false` until an
 * Amp-plugin adapter exists.
 */

import { AMP_MODES, type AmpMode } from "./amp-runner.js";

export const AMP_WORKER_ADAPTER = "amp-worker";

export interface AmpWorkerSubtreeCapability {
  spawn: false;
  reason: string;
  adapter: string;
  adapterVersion: string;
}

export interface AmpWorkerCapabilities {
  role: "worker";
  harness: "amp";
  adapter: string;
  adapterVersion: string;
  modes: readonly AmpMode[];
  mode: AmpMode;
  /** Steering applies at the next safe boundary (between Amp executions). */
  steer: "next-safe-boundary";
  /** Interrupt is a SIGTERM of the locally owned Amp child process only. */
  interrupt: "sigterm-owned-process";
  /** Reload re-registers with refreshed metadata; no runtime is restarted. */
  reload: "reregister-metadata";
  exit: true;
  subtree: AmpWorkerSubtreeCapability;
}

export function buildAmpWorkerCapabilities(input: {
  adapterVersion: string;
  mode: AmpMode;
}): AmpWorkerCapabilities {
  return {
    role: "worker",
    harness: "amp",
    adapter: AMP_WORKER_ADAPTER,
    adapterVersion: input.adapterVersion,
    modes: AMP_MODES,
    mode: input.mode,
    steer: "next-safe-boundary",
    interrupt: "sigterm-owned-process",
    reload: "reregister-metadata",
    exit: true,
    subtree: {
      spawn: false,
      reason:
        "Amp exposes no broker-callable child-thread API; cross-thread child tools are prompt-driven inside Amp. A future Amp-plugin adapter can flip this capability on.",
      adapter: AMP_WORKER_ADAPTER,
      adapterVersion: input.adapterVersion,
    },
  };
}
