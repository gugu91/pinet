import assert from "node:assert/strict";
import { createAbortError } from "@pinet/transport-core/async";
import type { SlackBridgeRuntimeMode } from "./runtime-mode.js";

export type ActiveRuntimeMode = Exclude<SlackBridgeRuntimeMode, "off">;

export type PinetRuntimeState<Role> =
  | { kind: "off" }
  | { kind: "starting"; mode: ActiveRuntimeMode }
  | { kind: "running"; mode: ActiveRuntimeMode; role: Role }
  | { kind: "stopping"; mode: ActiveRuntimeMode };

export interface PinetRuntimeHooks<Role, Context> {
  /**
   * Start `mode`. Call `publish` once the role is usable; work after it still
   * belongs to this start. Throwing (or an abort of `signal`) ends in a stop.
   */
  start(
    context: Context,
    mode: ActiveRuntimeMode,
    io: { signal: AbortSignal; publish: (role: Role) => Promise<void> },
  ): Promise<void>;
  /** Stop whatever is running, including a partial start. */
  stop(context: Context, options: { releaseIdentity: boolean }): Promise<void>;
  /**
   * Reload the running role in place or by restarting it. `setRole(null)`
   * marks the role unusable while it restarts; `setRole(role)` publishes the
   * restarted one. Ending without a role leaves the runtime off.
   */
  reload(
    context: Context,
    running: { mode: ActiveRuntimeMode; role: Role },
    io: { setRole: (role: Role | null) => Promise<void> },
  ): Promise<void>;
  /** Called after every state change, in order. */
  onChange(context: Context, state: PinetRuntimeState<Role>): Promise<void>;
}

export interface PinetRuntime<Role, Context> {
  state(): PinetRuntimeState<Role>;
  /** The mode most recently asked for, whether or not it is running yet. */
  requestedMode(): SlackBridgeRuntimeMode;
  /**
   * Move to `mode`. The latest request wins: it aborts a start in progress and
   * replaces queued requests, which then resolve without effect. Rejects if
   * this request's start fails.
   */
  setMode(
    context: Context,
    mode: SlackBridgeRuntimeMode,
    options?: { releaseIdentity?: boolean },
  ): Promise<void>;
  /** Reload the running role. Concurrent calls share one reload. */
  reload(context: Context): Promise<void>;
  /** Resolves once every request so far has been handled. */
  settled(): Promise<void>;
}

type Request<Context> =
  | {
      kind: "mode";
      context: Context;
      mode: SlackBridgeRuntimeMode;
      releaseIdentity: boolean;
      resolve: () => void;
      reject: (error: Error) => void;
    }
  | {
      kind: "reload";
      context: Context;
      promise: Promise<void>;
      resolve: () => void;
      reject: (error: Error) => void;
    };

/**
 * The single owner of a Pinet process's runtime mode. Requests run one at a
 * time, so a start, stop and reload never overlap, and a start that finishes
 * after it was superseded is stopped rather than published.
 *
 * A hook may make requests, which queue behind the one running it, but must
 * not await them: the request it waits for cannot start until the hook ends.
 */
export function createPinetRuntime<Role, Context>(
  hooks: PinetRuntimeHooks<Role, Context>,
): PinetRuntime<Role, Context> {
  let state: PinetRuntimeState<Role> = { kind: "off" };
  let requested: SlackBridgeRuntimeMode = "off";
  // Counts mode requests, so a failure only forgets `requested` if nothing newer asked for it.
  let modeRequests = 0;
  let starting: { mode: ActiveRuntimeMode; controller: AbortController } | null = null;
  let reloading: Promise<void> | null = null;
  const queue: Request<Context>[] = [];
  let draining: Promise<void> | null = null;

  async function setState(context: Context, next: PinetRuntimeState<Role>): Promise<void> {
    state = next;
    await hooks.onChange(context, next);
  }

  // agent-standards-ignore prefer-inline-single-use-helper: one handler per request kind.
  async function applyMode(
    context: Context,
    mode: SlackBridgeRuntimeMode,
    releaseIdentity: boolean,
  ): Promise<void> {
    const generation = modeRequests;
    if (state.kind === "running" && state.mode === mode) {
      await hooks.onChange(context, state);
      return;
    }
    if (state.kind === "running") {
      await setState(context, { kind: "stopping", mode: state.mode });
      await hooks.stop(context, { releaseIdentity });
    }
    if (mode === "off") {
      await setState(context, { kind: "off" });
      return;
    }

    const controller = new AbortController();
    starting = { mode, controller };
    await setState(context, { kind: "starting", mode });
    try {
      await hooks.start(context, mode, {
        signal: controller.signal,
        publish: async (role) => {
          controller.signal.throwIfAborted();
          await setState(context, { kind: "running", mode, role });
        },
      });
      controller.signal.throwIfAborted();
      assert(state.kind === "running", `Pinet ${mode} start finished without publishing a role`);
    } catch (error) {
      const cancelled = controller.signal.aborted;
      await setState(context, { kind: "stopping", mode });
      await hooks.stop(context, { releaseIdentity: !cancelled });
      await setState(context, { kind: "off" });
      if (cancelled) return;
      if (modeRequests === generation) requested = "off";
      throw error;
    } finally {
      starting = null;
    }
  }

  // agent-standards-ignore prefer-inline-single-use-helper: one handler per request kind.
  async function applyReload(context: Context): Promise<void> {
    if (state.kind !== "running") throw new Error("Pinet is not running.");
    const { mode, role } = state;
    const generation = modeRequests;
    try {
      await hooks.reload(
        context,
        { mode, role },
        {
          setRole: (next) =>
            setState(
              context,
              next === null ? { kind: "starting", mode } : { kind: "running", mode, role: next },
            ),
        },
      );
    } finally {
      if (state.kind !== "running") {
        await hooks.stop(context, { releaseIdentity: false });
        await setState(context, { kind: "off" });
        if (modeRequests === generation) requested = "off";
      }
    }
  }

  function enqueue(request: Request<Context>): void {
    queue.push(request);
    if (draining) return;
    draining = (async () => {
      // Yield first, so `draining` is set before any hook runs and a request a
      // hook makes joins this queue instead of starting a second drain.
      await Promise.resolve();
      try {
        for (let request = queue.shift(); request; request = queue.shift()) {
          try {
            if (request.kind === "mode") {
              await applyMode(request.context, request.mode, request.releaseIdentity);
            } else {
              reloading = request.promise;
              await applyReload(request.context);
            }
            request.resolve();
          } catch (error) {
            request.reject(error instanceof Error ? error : new Error(String(error)));
          } finally {
            if (request.kind === "reload") reloading = null;
          }
        }
      } finally {
        // Cleared in the same tick as the last request settles, so a request made
        // by that request's caller starts a new drain.
        draining = null;
      }
    })();
  }

  return {
    state: () => state,
    requestedMode: () => requested,
    setMode(context, mode, options = {}) {
      requested = mode;
      modeRequests++;
      for (let index = queue.length - 1; index >= 0; index--) {
        const queued = queue[index];
        if (queued.kind !== "mode") continue;
        queue.splice(index, 1);
        queued.resolve();
      }
      if (starting && starting.mode !== mode) {
        starting.controller.abort(createAbortError(`Pinet ${starting.mode} start superseded`));
      }
      return new Promise<void>((resolve, reject) => {
        enqueue({
          kind: "mode",
          context,
          mode,
          releaseIdentity: options.releaseIdentity ?? true,
          resolve,
          reject,
        });
      });
    },
    reload(context) {
      const queued = queue.find((request) => request.kind === "reload");
      if (queued) return queued.promise;
      if (reloading && queue.length === 0) return reloading;
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      enqueue({ kind: "reload", context, promise, resolve, reject });
      return promise;
    },
    async settled() {
      while (draining) await draining;
    },
  };
}
