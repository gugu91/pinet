import { describe, expect, it } from "vitest";
import type { SecurityGuardrails } from "./guardrails.js";
import {
  DEFAULT_CONFIRMATION_REQUEST_TTL_MS,
  confirmationRequestMatches,
  consumeMatchingConfirmationRequest,
  isThreadConfirmationStateEmpty,
  normalizeThreadConfirmationState,
  registerThreadConfirmationRequest,
  type ThreadConfirmationState,
} from "./helpers.js";
import { createThreadConfirmationPolicy } from "./thread-confirmations.js";

function makeState(): ThreadConfirmationState {
  return {
    pending: [],
    approved: [],
    rejected: [],
  };
}

function createPolicyHarness(initialGuardrails: SecurityGuardrails = {}) {
  let guardrails = initialGuardrails;
  let now = Date.parse("2026-04-14T12:00:00Z");
  const policy = createThreadConfirmationPolicy({
    getGuardrails: () => guardrails,
    now: () => now,
  });

  return {
    policy,
    setGuardrails(next: SecurityGuardrails) {
      guardrails = next;
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("thread confirmation helper state", () => {
  it("expires stale pending, approved, and rejected requests", () => {
    const now = Date.now();
    const fresh = now - 1_000;
    const stale = now - DEFAULT_CONFIRMATION_REQUEST_TTL_MS - 1_000;
    const state: ThreadConfirmationState = {
      pending: [
        { toolPattern: "bash", action: "fresh pending", requestedAt: fresh },
        { toolPattern: "edit", action: "stale pending", requestedAt: stale },
      ],
      approved: [
        { toolPattern: "write", action: "fresh approved", requestedAt: fresh },
        { toolPattern: "memory_write", action: "stale approved", requestedAt: stale },
      ],
      rejected: [
        { toolPattern: "bash", action: "fresh rejected", requestedAt: fresh },
        { toolPattern: "edit", action: "stale rejected", requestedAt: stale },
      ],
    };

    expect(normalizeThreadConfirmationState(state, now)).toEqual({
      pending: [{ toolPattern: "bash", action: "fresh pending", requestedAt: fresh }],
      approved: [{ toolPattern: "write", action: "fresh approved", requestedAt: fresh }],
      rejected: [{ toolPattern: "bash", action: "fresh rejected", requestedAt: fresh }],
    });
  });

  it("clears ambiguous pending requests instead of guessing which reply belongs to which action", () => {
    const now = Date.now();
    const state: ThreadConfirmationState = {
      pending: [
        { toolPattern: "bash", action: "first", requestedAt: now - 2_000 },
        { toolPattern: "edit", action: "second", requestedAt: now - 1_000 },
      ],
      approved: [],
      rejected: [],
    };

    expect(normalizeThreadConfirmationState(state, now).pending).toEqual([]);
  });

  it("detects when a confirmation state is empty", () => {
    expect(isThreadConfirmationStateEmpty(makeState())).toBe(true);
    expect(
      isThreadConfirmationStateEmpty({
        pending: [{ toolPattern: "bash", action: "run", requestedAt: Date.now() }],
        approved: [],
        rejected: [],
      }),
    ).toBe(false);
  });

  it("matches only when both tool pattern and action line up", () => {
    const request = {
      toolPattern: "bash",
      action: "run: echo hello",
      requestedAt: Date.now(),
    };

    expect(confirmationRequestMatches(request, "bash", "run: echo hello")).toBe(true);
    expect(confirmationRequestMatches(request, "bash", "run: echo goodbye")).toBe(false);
    expect(confirmationRequestMatches(request, "edit", "run: echo hello")).toBe(false);
  });

  it("consumes only the exact approved or rejected action", () => {
    const list = [
      { toolPattern: "bash", action: "run: echo hello", requestedAt: Date.now() - 2_000 },
      { toolPattern: "bash", action: "run: echo goodbye", requestedAt: Date.now() - 1_000 },
    ];

    const consumed = consumeMatchingConfirmationRequest(list, "bash", "run: echo goodbye");

    expect(consumed?.action).toBe("run: echo goodbye");
    expect(list.map((request) => request.action)).toEqual(["run: echo hello"]);
    expect(consumeMatchingConfirmationRequest(list, "bash", "run: echo unknown")).toBeNull();
  });

  it("creates a new pending request when the thread is clear", () => {
    const now = Date.now();
    const result = registerThreadConfirmationRequest(
      { pending: [], approved: [], rejected: [] },
      { toolPattern: "bash", action: "run: ls", requestedAt: now },
      now,
    );

    expect(result.status).toBe("created");
    expect(result.state.pending).toEqual([
      { toolPattern: "bash", action: "run: ls", requestedAt: now },
    ]);
  });

  it("refreshes an identical pending request without duplicating it", () => {
    const now = Date.now();
    const result = registerThreadConfirmationRequest(
      {
        pending: [{ toolPattern: "bash", action: "run: ls", requestedAt: now - 5_000 }],
        approved: [],
        rejected: [],
      },
      { toolPattern: "bash", action: "run: ls", requestedAt: now },
      now,
    );

    expect(result.status).toBe("refreshed");
    expect(result.state.pending).toEqual([
      { toolPattern: "bash", action: "run: ls", requestedAt: now },
    ]);
  });

  it("rejects a different pending request so a plain yes/no cannot bind to the wrong action", () => {
    const now = Date.now();
    const result = registerThreadConfirmationRequest(
      {
        pending: [{ toolPattern: "bash", action: "run: ls", requestedAt: now - 5_000 }],
        approved: [],
        rejected: [],
      },
      { toolPattern: "edit", action: "edit: README.md", requestedAt: now },
      now,
    );

    expect(result.status).toBe("conflict");
    expect(result.conflict).toEqual({
      toolPattern: "bash",
      action: "run: ls",
      requestedAt: now - 5_000,
    });
    expect(result.state.pending).toEqual([
      { toolPattern: "bash", action: "run: ls", requestedAt: now - 5_000 },
    ]);
  });

  it("drops stale matching approvals when requesting a fresh confirmation for the same action", () => {
    const now = Date.now();
    const result = registerThreadConfirmationRequest(
      {
        pending: [],
        approved: [{ toolPattern: "bash", action: "run: ls", requestedAt: now - 2_000 }],
        rejected: [{ toolPattern: "bash", action: "run: cat", requestedAt: now - 1_000 }],
      },
      { toolPattern: "bash", action: "run: ls", requestedAt: now },
      now,
    );

    expect(result.status).toBe("created");
    expect(result.state.approved).toEqual([]);
    expect(result.state.rejected).toEqual([
      { toolPattern: "bash", action: "run: cat", requestedAt: now - 1_000 },
    ]);
    expect(result.state.pending).toEqual([
      { toolPattern: "bash", action: "run: ls", requestedAt: now },
    ]);
  });
});

describe("createThreadConfirmationPolicy", () => {
  it("formats confirmation actions deterministically", () => {
    const { policy } = createPolicyHarness();

    expect(policy.formatAction('run: echo "hello"')).toBe(JSON.stringify('run: echo "hello"'));
  });

  it("registers, approves, and allows a confirmed action once", () => {
    const { policy } = createPolicyHarness({ requireConfirmation: ["bash"] });

    expect(() => policy.requireToolPolicy("bash", "100.1", "run: ls")).toThrow(
      'Tool "bash" requires confirmation for action "run: ls". Call slack with action "confirm_action" in thread 100.1 using tool "bash" and action "run: ls", then wait for the user\'s approval first.',
    );

    expect(policy.registerRequest("100.1", "bash", "run: ls").status).toBe("created");
    expect(() => policy.requireToolPolicy("bash", "100.1", "run: ls")).toThrow(
      'Tool "bash" requires confirmation for action "run: ls". A matching confirmation request is already pending in thread 100.1; wait for the user\'s approval first.',
    );

    expect(policy.consumeReply("100.1", "yes")).toEqual({ approved: true });
    expect(() => policy.requireToolPolicy("bash", "100.1", "run: ls")).not.toThrow();
    expect(() => policy.requireToolPolicy("bash", "100.1", "run: ls")).toThrow(
      'Tool "bash" requires confirmation for action "run: ls". Call slack with action "confirm_action" in thread 100.1 using tool "bash" and action "run: ls", then wait for the user\'s approval first.',
    );
  });

  it("denies a rejected action", () => {
    const { policy } = createPolicyHarness({ requireConfirmation: ["bash"] });

    expect(policy.registerRequest("100.1", "bash", "run: rm -rf /").status).toBe("created");
    expect(policy.consumeReply("100.1", "no")).toEqual({ approved: false });
    expect(() => policy.requireToolPolicy("bash", "100.1", "run: rm -rf /")).toThrow(
      'Tool "bash" was denied by Slack user confirmation for action "run: rm -rf /".',
    );
  });

  it("surfaces conflicting pending requests in the same thread", () => {
    const { policy } = createPolicyHarness({ requireConfirmation: ["bash", "edit"] });

    expect(policy.registerRequest("100.1", "edit", "edit: README.md").status).toBe("created");
    expect(() => policy.requireToolPolicy("bash", "100.1", "run: ls")).toThrow(
      'Thread 100.1 already has a pending confirmation for tool "edit" and action "edit: README.md". Wait for a reply or expiry before requesting another action in the same thread.',
    );
  });

  it("rejects confirmation-required actions without a thread", () => {
    const { policy } = createPolicyHarness({ requireConfirmation: ["bash"] });

    expect(() => policy.requireToolPolicy("bash", undefined, "run: ls")).toThrow(
      'Tool "bash" requires confirmation for action "run: ls". Include a thread_ts and call slack with action "confirm_action" before executing this tool.',
    );
  });

  it("blocks tools before confirmation logic runs", () => {
    const { policy } = createPolicyHarness({
      blockedTools: ["bash"],
      requireConfirmation: ["bash"],
    });

    expect(() => policy.requireToolPolicy("bash", "100.1", "run: ls")).toThrow(
      'Tool "bash" is blocked by Slack security guardrails.',
    );
  });

  it("does not consume timestamped replies that predate the pending request", () => {
    const { policy, advance } = createPolicyHarness({
      requireConfirmation: ["bash"],
    });

    const staleReplyAt = "2026-04-14T11:59:59.000Z";
    expect(policy.registerRequest("100.1", "bash", "run: ls").status).toBe("created");

    expect(policy.consumeReply("100.1", "yes", { receivedAt: staleReplyAt })).toBeNull();
    expect(() => policy.requireToolPolicy("bash", "100.1", "run: ls")).toThrow(
      'Tool "bash" requires confirmation for action "run: ls". A matching confirmation request is already pending in thread 100.1; wait for the user\'s approval first.',
    );

    advance(1_000);
    expect(policy.consumeReply("100.1", "yes", { receivedAt: "2026-04-14T12:00:01.000Z" })).toEqual(
      { approved: true },
    );
    expect(() => policy.requireToolPolicy("bash", "100.1", "run: ls")).not.toThrow();
  });

  it("ignores non-confirmation replies and expires stale pending requests", () => {
    const { policy, advance, setGuardrails } = createPolicyHarness({
      requireConfirmation: ["bash"],
    });

    expect(policy.registerRequest("100.1", "bash", "run: ls").status).toBe("created");
    expect(policy.consumeReply("100.1", "maybe later")).toBeNull();

    advance(DEFAULT_CONFIRMATION_REQUEST_TTL_MS + 1);
    expect(() => policy.requireToolPolicy("bash", "100.1", "run: ls")).toThrow(
      'Tool "bash" requires confirmation for action "run: ls". Call slack with action "confirm_action" in thread 100.1 using tool "bash" and action "run: ls", then wait for the user\'s approval first.',
    );

    setGuardrails({});
    expect(() => policy.requireToolPolicy("bash", "100.1", "run: ls")).not.toThrow();
  });
});
