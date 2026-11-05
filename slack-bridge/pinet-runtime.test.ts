import { describe, expect, it } from "vitest";
import { createPinetRuntime, type ActiveRuntimeMode, type PinetRuntime } from "./pinet-runtime.js";
import type { SlackBridgeRuntimeMode } from "./runtime-mode.js";

interface PendingStart {
  mode: ActiveRuntimeMode;
  succeed: () => void;
  fail: (error: Error) => void;
}

/**
 * Hooks backed by one fake resource. A start acquires it, a stop releases it,
 * and each start waits until the test settles it.
 */
function createHarness() {
  const log: string[] = [];
  const pending: PendingStart[] = [];
  let live = 0;
  let activeHooks = 0;
  let maxActiveHooks = 0;
  let roleId = 0;

  async function inHook<T>(work: () => Promise<T>): Promise<T> {
    activeHooks++;
    maxActiveHooks = Math.max(maxActiveHooks, activeHooks);
    try {
      return await work();
    } finally {
      activeHooks--;
    }
  }

  const runtime: PinetRuntime<number, null> = createPinetRuntime<number, null>({
    start: (_context, mode, { signal, publish }) =>
      inHook(async () => {
        log.push(`start ${mode}`);
        expect(live).toBe(0);
        live++;
        await new Promise<void>((resolve, reject) => {
          pending.push({ mode, succeed: resolve, fail: reject });
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        await publish(++roleId);
      }),
    stop: (_context, { releaseIdentity }) =>
      inHook(async () => {
        log.push(`stop release=${releaseIdentity}`);
        live = 0;
      }),
    reload: (_context, running, { setRole }) =>
      inHook(async () => {
        log.push(`reload ${running.mode}`);
        await setRole(null);
        await setRole(++roleId);
      }),
    onChange: async () => undefined,
  });

  return {
    runtime,
    log,
    pending,
    live: () => live,
    maxActiveHooks: () => maxActiveHooks,
    async flush() {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
  };
}

describe("createPinetRuntime", () => {
  it("starts, publishes the role, and stops with identity release on a mode change", async () => {
    const h = createHarness();
    const following = h.runtime.setMode(null, "follower");
    await h.flush();
    expect(h.runtime.state()).toEqual({ kind: "starting", mode: "follower" });
    h.pending.shift()!.succeed();
    await following;
    expect(h.runtime.state()).toEqual({ kind: "running", mode: "follower", role: 1 });

    await h.runtime.setMode(null, "off");
    expect(h.runtime.state()).toEqual({ kind: "off" });
    expect(h.log).toEqual(["start follower", "stop release=true"]);
  });

  it("aborts a start that a later request supersedes and never publishes it", async () => {
    const h = createHarness();
    const following = h.runtime.setMode(null, "follower");
    await h.flush();
    const turningOff = h.runtime.setMode(null, "off");

    await expect(following).resolves.toBeUndefined();
    await turningOff;
    expect(h.runtime.state()).toEqual({ kind: "off" });
    expect(h.runtime.requestedMode()).toBe("off");
    expect(h.live()).toBe(0);
    expect(h.log).toEqual(["start follower", "stop release=false"]);
  });

  it("stops a superseded start whose work finishes anyway", async () => {
    const h = createHarness();
    const runtime = createPinetRuntime<number, null>({
      start: async (_context, _mode, { publish }) => {
        h.log.push("start");
        // Ignores the abort signal, as a slow connect might.
        await new Promise<void>((resolve) =>
          h.pending.push({ mode: "follower", succeed: resolve, fail: () => resolve() }),
        );
        await publish(1);
      },
      stop: async () => {
        h.log.push("stop");
      },
      reload: async () => undefined,
      onChange: async () => undefined,
    });
    const following = runtime.setMode(null, "follower");
    await h.flush();
    const turningOff = runtime.setMode(null, "off");
    h.pending.shift()!.succeed();
    await Promise.all([following, turningOff]);

    expect(runtime.state()).toEqual({ kind: "off" });
    expect(h.log).toEqual(["start", "stop"]);
  });

  it("rejects a failed start, cleans up with identity release, and forgets the mode", async () => {
    const h = createHarness();
    const following = h.runtime.setMode(null, "follower");
    await h.flush();
    h.pending.shift()!.fail(new Error("no broker"));

    await expect(following).rejects.toThrow("no broker");
    expect(h.runtime.state()).toEqual({ kind: "off" });
    expect(h.runtime.requestedMode()).toBe("off");
    expect(h.log).toEqual(["start follower", "stop release=true"]);
  });

  it("keeps a newer request for the same mode when an earlier start fails", async () => {
    const h = createHarness();
    const first = h.runtime.setMode(null, "follower");
    await h.flush();
    const second = h.runtime.setMode(null, "follower");
    h.pending.shift()!.fail(new Error("no broker yet"));
    await expect(first).rejects.toThrow("no broker yet");
    await h.flush();
    h.pending.shift()!.succeed();
    await second;

    expect(h.runtime.requestedMode()).toBe("follower");
    expect(h.runtime.state()).toMatchObject({ kind: "running", mode: "follower" });
  });

  it("re-runs the same mode without restarting it", async () => {
    const h = createHarness();
    const first = h.runtime.setMode(null, "broker");
    await h.flush();
    h.pending.shift()!.succeed();
    await first;
    await h.runtime.setMode(null, "broker");
    expect(h.log).toEqual(["start broker"]);
  });

  it("refuses to reload while off and shares one reload between concurrent callers", async () => {
    const h = createHarness();
    await expect(h.runtime.reload(null)).rejects.toThrow("Pinet is not running.");

    const following = h.runtime.setMode(null, "follower");
    await h.flush();
    h.pending.shift()!.succeed();
    await following;
    const first = h.runtime.reload(null);
    const second = h.runtime.reload(null);
    expect(second).toBe(first);
    await first;
    expect(h.log.filter((entry) => entry.startsWith("reload"))).toEqual(["reload follower"]);
    expect(h.runtime.state()).toEqual({ kind: "running", mode: "follower", role: 2 });
  });

  it("ends off when a reload leaves no role", async () => {
    const runtime = createPinetRuntime<number, null>({
      start: async (_context, _mode, { publish }) => publish(1),
      stop: async () => undefined,
      reload: async (_context, _running, { setRole }) => {
        await setRole(null);
        throw new Error("restart and rollback failed");
      },
      onChange: async () => undefined,
    });
    await runtime.setMode(null, "follower");
    await expect(runtime.reload(null)).rejects.toThrow("restart and rollback failed");
    expect(runtime.state()).toEqual({ kind: "off" });
    expect(runtime.requestedMode()).toBe("off");
  });

  it.each(["synchronously", "after an await"])(
    "queues a request a hook makes %s behind the current one",
    async (timing) => {
      const log: string[] = [];
      let active = 0;
      let maxActive = 0;
      async function hook(name: string, work: () => Promise<void>): Promise<void> {
        active++;
        maxActive = Math.max(maxActive, active);
        log.push(name);
        try {
          for (let i = 0; i < 5; i++) await Promise.resolve();
          await work();
        } finally {
          active--;
        }
      }
      const runtime: PinetRuntime<number, null> = createPinetRuntime<number, null>({
        start: (_context, mode, { publish }) => hook(`start ${mode}`, () => publish(1)),
        stop: () => hook("stop", async () => undefined),
        reload: async (_context, _running, { setRole }) => {
          if (timing === "synchronously") void runtime.setMode(null, "off");
          await hook("reload", async () => {
            // A hook that triggers a mode change, as a terminal broker failure might.
            if (timing === "after an await") void runtime.setMode(null, "off");
            await setRole(2);
          });
        },
        onChange: async () => undefined,
      });
      await runtime.setMode(null, "follower");
      await runtime.reload(null);
      await runtime.settled();

      expect(maxActive).toBe(1);
      expect(log).toEqual(["start follower", "reload", "stop"]);
      expect(runtime.requestedMode()).toBe("off");
      expect(runtime.state()).toEqual({ kind: "off" });
    },
  );

  it("keeps its invariants under random interleavings", async () => {
    const modes: SlackBridgeRuntimeMode[] = ["off", "single", "broker", "follower"];
    for (let seed = 1; seed <= 200; seed++) {
      let value = seed;
      const random = (n: number) => {
        value = (Math.imul(value, 1103515245) + 12345) >>> 0;
        return (value >>> 16) % n;
      };
      const h = createHarness();
      const calls: Array<Promise<void>> = [];
      let lastFailedStart: ActiveRuntimeMode | null = null;

      for (let step = 0; step < 25; step++) {
        const choice = random(4);
        if (choice === 0) {
          lastFailedStart = null;
          calls.push(h.runtime.setMode(null, modes[random(4)]).catch(() => undefined));
        } else if (choice === 1) {
          calls.push(h.runtime.reload(null).catch(() => undefined));
        } else if (h.pending.length > 0) {
          const start = h.pending.shift()!;
          if (choice === 2) {
            start.succeed();
          } else {
            lastFailedStart = start.mode;
            start.fail(new Error("start failed"));
          }
        }
        await h.flush();
        expect(h.maxActiveHooks()).toBeLessThanOrEqual(1);
      }

      // Let every remaining start succeed, then check where the runtime settled.
      for (;;) {
        await h.flush();
        const start = h.pending.shift();
        if (!start) break;
        start.succeed();
      }
      await Promise.all(calls);
      await h.runtime.settled();

      const state = h.runtime.state();
      const requested = h.runtime.requestedMode();
      const context = `seed ${seed}: requested ${requested}, state ${JSON.stringify(state)}, last failed ${lastFailedStart}`;
      if (requested === "off") {
        expect(state, context).toEqual({ kind: "off" });
        expect(h.live(), context).toBe(0);
      } else {
        expect(state.kind, context).toBe("running");
        expect(state.kind === "running" && state.mode, context).toBe(requested);
        expect(h.live(), context).toBe(1);
      }
    }
  });
});
