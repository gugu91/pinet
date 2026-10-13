import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoalNetworkRecovery, type GoalNetworkRecoveryRequest } from "./network-recovery.js";

describe("bounded goal network recovery", () => {
  let now: number;
  let recovery: GoalNetworkRecovery;
  let request: GoalNetworkRecoveryRequest;
  let wakes: Array<() => void>;
  const probe = vi.fn().mockResolvedValue(true);
  const pause = vi.fn();

  beforeEach(() => {
    now = 0;
    wakes = [];
    vi.clearAllMocks();
    probe.mockResolvedValue(true);
    pause.mockImplementation(
      (_milliseconds: number, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          wakes.push(resolve);
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    recovery = new GoalNetworkRecovery(probe, pause, () => now);
    request = {
      target: { hostname: "example.com", port: 443 },
      canResume: vi.fn().mockResolvedValue(true),
      resume: vi.fn().mockResolvedValue("resumed"),
      stopped: vi.fn(),
    };
  });
  afterEach(() => recovery.cancel());

  const tick = async (): Promise<void> => {
    now += 15_000;
    const previousStops = vi.mocked(request.stopped).mock.calls.length;
    wakes.shift()?.();
    await vi.waitFor(() =>
      expect(wakes.length > 0 || vi.mocked(request.stopped).mock.calls.length > previousStops).toBe(
        true,
      ),
    );
  };

  it("waits until the configured endpoint is reachable, then resumes once", async () => {
    probe.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(recovery.start(request)).toBe(true);
    expect(pause).toHaveBeenCalledWith(15_000, expect.any(AbortSignal));
    expect(request.resume).not.toHaveBeenCalled();
    await tick();
    expect(request.resume).not.toHaveBeenCalled();
    await tick();
    expect(request.resume).toHaveBeenCalledTimes(1);
    expect(request.stopped).toHaveBeenCalledWith("resumed");
  });

  it("keeps polling busy ownership without stopping or consuming the resume cap", async () => {
    vi.mocked(request.resume).mockResolvedValue("busy");
    recovery.start(request);
    for (let attempt = 0; attempt < 21; attempt += 1) await tick();
    expect(request.stopped).not.toHaveBeenCalled();
    vi.mocked(request.resume).mockResolvedValue("resumed");
    await tick();
    expect(request.stopped).toHaveBeenCalledWith("resumed");
    for (let attempt = 0; attempt < 19; attempt += 1) {
      expect(recovery.start(request)).toBe(true);
      await tick();
    }
    expect(recovery.start(request)).toBe(false);
  });

  it("busy ownership still expires at the thirty-minute deadline", async () => {
    vi.mocked(request.resume).mockResolvedValue("busy");
    recovery.start(request);
    await tick();
    now = 30 * 60_000;
    await tick();
    expect(request.stopped).toHaveBeenCalledWith("expired");
    expect(request.resume).toHaveBeenCalledTimes(1);
  });

  it("cancelling a busy recovery prevents later polling from reviving it", async () => {
    vi.mocked(request.resume).mockResolvedValue("busy");
    recovery.start(request);
    await tick();
    recovery.cancel();
    await vi.waitFor(() => expect(request.stopped).toHaveBeenCalledWith("cancelled"));
    expect(request.resume).toHaveBeenCalledTimes(1);
  });

  it("a cancelled resume is not reported as recovered", async () => {
    vi.mocked(request.resume).mockResolvedValue("cancelled");
    recovery.start(request);
    await tick();
    expect(request.stopped).toHaveBeenCalledWith("cancelled");
  });

  it("cancels pending waits without probing or resuming", async () => {
    recovery.start(request);
    recovery.cancel();
    await vi.waitFor(() => expect(request.stopped).toHaveBeenCalledWith("cancelled"));
    expect(probe).not.toHaveBeenCalled();
    expect(request.resume).not.toHaveBeenCalled();
  });

  it("rechecks ownership after a successful probe", async () => {
    vi.mocked(request.canResume).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    recovery.start(request);
    await tick();
    expect(request.resume).not.toHaveBeenCalled();
    expect(request.stopped).toHaveBeenCalledWith("cancelled");
  });

  it("expires after thirty minutes without an extra probe", async () => {
    recovery.start(request);
    now = 30 * 60_000;
    await tick();
    expect(request.stopped).toHaveBeenCalledWith("expired");
    expect(probe).not.toHaveBeenCalled();
  });

  it("caps automatic resumes at twenty per extension session", async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(recovery.start(request)).toBe(true);
      await tick();
      await vi.waitFor(() => expect(request.resume).toHaveBeenCalledTimes(attempt + 1));
    }
    expect(recovery.start(request)).toBe(false);
    expect(request.resume).toHaveBeenCalledTimes(20);
  });
});
