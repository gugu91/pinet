import { describe, expect, it, vi } from "vitest";
import {
  inspectBrokerManagedTmuxSessionPresence,
  inspectTmuxSessionPresence,
  parseTmuxListClients,
  parseTmuxListSessions,
  parseTmuxPanePids,
  summarizeTmuxSessionPresence,
} from "./tmux-presence.js";

describe("tmux presence helpers", () => {
  it("parses tmux session attachment counts", () => {
    expect(parseTmuxListSessions("worker-one\t0\nworker-two\t2\nmalformed\n")).toEqual([
      { session: "worker-one", attachedClientCount: 0 },
      { session: "worker-two", attachedClientCount: 2 },
    ]);
  });

  it("parses tmux clients without exposing terminal details", () => {
    expect(parseTmuxListClients("worker-one\t100\t0\nworker-one\t101\t1\n")).toEqual([
      { session: "worker-one", activityAtMs: 100_000, controlMode: false },
      { session: "worker-one", activityAtMs: 101_000, controlMode: true },
    ]);
  });

  it("parses pane pids for broker-managed ownership checks", () => {
    expect(parseTmuxPanePids("101\nnot-a-pid\n1\n202\n")).toEqual([101, 202]);
  });

  it("summarizes only explicitly allowed sessions", () => {
    const result = summarizeTmuxSessionPresence(
      ["worker-one"],
      [
        { session: "worker-one", attachedClientCount: 2 },
        { session: "private-shell", attachedClientCount: 1 },
      ],
      [
        { session: "worker-one", activityAtMs: 1_000, controlMode: false },
        { session: "worker-one", activityAtMs: 2_000, controlMode: true },
        { session: "private-shell", activityAtMs: 3_000, controlMode: false },
      ],
      2_000,
    );

    expect(result.get("worker-one")).toEqual({
      session: "worker-one",
      status: "attached",
      attachedClientCount: 2,
      interactiveClientCount: 1,
      controlClientCount: 1,
      recentInteractiveClientCount: 1,
      latestClientActivityAt: "1970-01-01T00:00:02.000Z",
      latestInteractiveClientActivityAt: "1970-01-01T00:00:01.000Z",
      probedAt: "1970-01-01T00:00:02.000Z",
    });
    expect(result.has("private-shell")).toBe(false);
  });

  it("marks mapped sessions missing from tmux as unknown", () => {
    const result = summarizeTmuxSessionPresence(["missing-worker"], [], [], 1_000);

    expect(result.get("missing-worker")).toMatchObject({
      session: "missing-worker",
      status: "unknown",
      error: "tmux_session_not_found",
    });
  });

  it("fails closed when tmux cannot be inspected", () => {
    const execFileSync = vi.fn(() => {
      throw new Error("tmux unavailable");
    });

    const result = inspectTmuxSessionPresence(["worker-one"], {
      execFileSync,
      now: () => 10_000,
    });

    expect(result.get("worker-one")).toEqual({
      session: "worker-one",
      status: "unknown",
      attachedClientCount: 0,
      interactiveClientCount: 0,
      controlClientCount: 0,
      recentInteractiveClientCount: 0,
      probedAt: "1970-01-01T00:00:10.000Z",
      error: "tmux_probe_failed",
    });
  });

  it("uses session attachment counts when list-clients has no rows", () => {
    const execFileSync = vi.fn().mockReturnValueOnce("worker-one\t1\n").mockReturnValueOnce("");

    const result = inspectTmuxSessionPresence(["worker-one"], {
      execFileSync,
      now: () => 10_000,
    });

    expect(result.get("worker-one")).toMatchObject({
      session: "worker-one",
      status: "attached",
      attachedClientCount: 1,
      interactiveClientCount: 0,
      controlClientCount: 0,
    });
  });

  it("requires a broker-managed target pid to own a pane before reporting clients", () => {
    const execFileSync = vi
      .fn()
      .mockReturnValueOnce("101\n")
      .mockReturnValueOnce("worker-one\t1\n")
      .mockReturnValueOnce("worker-one\t10\t0\n");

    const result = inspectBrokerManagedTmuxSessionPresence([{ session: "worker-one", pid: 101 }], {
      execFileSync,
      now: () => 10_000,
    });

    expect(result.get("worker-one")).toMatchObject({
      session: "worker-one",
      status: "attached",
      interactiveClientCount: 1,
      latestInteractiveClientActivityAt: "1970-01-01T00:00:10.000Z",
    });
  });

  it("fails closed when the claimed broker-managed pid is not a pane owner", () => {
    const execFileSync = vi.fn().mockReturnValueOnce("202\n");

    const result = inspectBrokerManagedTmuxSessionPresence([{ session: "worker-one", pid: 101 }], {
      execFileSync,
      now: () => 10_000,
    });

    expect(result.get("worker-one")).toEqual({
      session: "worker-one",
      status: "unknown",
      attachedClientCount: 0,
      interactiveClientCount: 0,
      controlClientCount: 0,
      recentInteractiveClientCount: 0,
      probedAt: "1970-01-01T00:00:10.000Z",
      error: "tmux_session_not_verified_for_agent_pid",
    });
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it("keeps broker-managed presence keyed to each agent id for reused sessions", () => {
    const execFileSync = vi
      .fn()
      .mockReturnValueOnce("101\n")
      .mockReturnValueOnce("worker-one\t1\n")
      .mockReturnValueOnce("worker-one\t10\t0\n");

    const result = inspectBrokerManagedTmuxSessionPresence(
      [
        { id: "active-agent", session: "worker-one", pid: 101 },
        { id: "stale-agent", session: "worker-one", pid: 202 },
      ],
      {
        execFileSync,
        now: () => 10_000,
      },
    );

    expect(result.get("active-agent")).toMatchObject({
      session: "worker-one",
      status: "attached",
      interactiveClientCount: 1,
      latestInteractiveClientActivityAt: "1970-01-01T00:00:10.000Z",
    });
    expect(result.get("stale-agent")).toEqual({
      session: "worker-one",
      status: "unknown",
      attachedClientCount: 0,
      interactiveClientCount: 0,
      controlClientCount: 0,
      recentInteractiveClientCount: 0,
      probedAt: "1970-01-01T00:00:10.000Z",
      error: "tmux_session_not_verified_for_agent_pid",
    });
    expect(execFileSync).toHaveBeenCalledTimes(3);
  });

  it("reports tmux probe failures separately from broker-managed pid mismatches", () => {
    const execFileSync = vi.fn(() => {
      throw new Error("tmux unavailable");
    });

    const result = inspectBrokerManagedTmuxSessionPresence([{ session: "worker-one", pid: 101 }], {
      execFileSync,
      now: () => 10_000,
    });

    expect(result.get("worker-one")).toEqual({
      session: "worker-one",
      status: "unknown",
      attachedClientCount: 0,
      interactiveClientCount: 0,
      controlClientCount: 0,
      recentInteractiveClientCount: 0,
      probedAt: "1970-01-01T00:00:10.000Z",
      error: "tmux_probe_failed",
    });
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });
});
