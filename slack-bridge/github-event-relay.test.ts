import { describe, expect, it } from "vitest";
import type { PinetLaneInfo, ThreadInfo } from "./broker/types.js";
import {
  buildGithubEventRelayEvent,
  buildGithubEventRelayPayload,
  formatGithubEventRelayText,
  mergeGithubEventRelayMetadata,
  resolveSafeGithubEventRelayTarget,
  selectPinetLanesForGithubEventRelay,
} from "./github-event-relay.js";

const baseAssignment = {
  agentId: "agent-1",
  issueNumber: 774,
  repoOwner: "gugu91",
  repoName: "extensions",
};

function lane(overrides: Partial<PinetLaneInfo>): PinetLaneInfo {
  return {
    laneId: "lane-1",
    name: null,
    task: null,
    issueNumber: 774,
    prNumber: null,
    threadId: null,
    ownerAgentId: null,
    implementationLeadAgentId: null,
    pmMode: false,
    state: "active",
    summary: null,
    metadata: null,
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
    lastActivityAt: "2026-06-04T00:00:00.000Z",
    participants: [],
    ...overrides,
  };
}

function thread(overrides: Partial<ThreadInfo>): ThreadInfo {
  return {
    threadId: "123.456",
    source: "slack",
    channel: "C123",
    ownerAgent: null,
    ownerBinding: null,
    metadata: null,
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
    ...overrides,
  };
}

describe("GitHub event relay helpers", () => {
  it("builds structured metadata and copy for PR open events", () => {
    const event = buildGithubEventRelayEvent(
      { ...baseAssignment, nextStatus: "pr_open", nextPrNumber: 123 },
      "2026-06-04T01:02:03.000Z",
    );

    expect(event).toMatchObject({
      eventType: "github_pr_lifecycle",
      eventId: "github:gugu91/extensions:issue:774:pr:123:status:pr_open",
      repoKey: "gugu91/extensions",
      status: "pr_open",
      url: "https://github.com/gugu91/extensions/pull/123",
    });
    expect(formatGithubEventRelayText(event!)).toBe(
      "GitHub relay: gugu91/extensions <https://github.com/gugu91/extensions/pull/123|PR #123> opened/ready for review for issue #774.",
    );
    expect(
      buildGithubEventRelayPayload(event!, {
        threadId: "123.456",
        source: "slack",
        channel: "C123",
      }).metadata,
    ).toMatchObject({
      githubEventRelay: event,
      github: {
        repoKey: "gugu91/extensions",
        prNumber: 123,
        status: "pr_open",
      },
    });
  });

  it("returns null for non-MVP statuses and missing PR numbers", () => {
    expect(
      buildGithubEventRelayEvent(
        { ...baseAssignment, nextStatus: "pr_closed", nextPrNumber: 123 },
        "2026-06-04T01:02:03.000Z",
      ),
    ).toBeNull();
    expect(
      buildGithubEventRelayEvent(
        { ...baseAssignment, nextStatus: "pr_open", nextPrNumber: null },
        "2026-06-04T01:02:03.000Z",
      ),
    ).toBeNull();
  });

  it("merges lane metadata without replacing unrelated keys", () => {
    const event = buildGithubEventRelayEvent(
      { ...baseAssignment, nextStatus: "pr_merged", nextPrNumber: 124 },
      "2026-06-04T01:02:03.000Z",
    )!;

    expect(
      mergeGithubEventRelayMetadata(
        {
          consent: "maintainer",
          github: { owner: "gugu91", repo: "extensions", previous: true },
        },
        event,
      ),
    ).toEqual({
      consent: "maintainer",
      githubEventRelay: event,
      github: {
        owner: "gugu91",
        repo: "extensions",
        previous: true,
        repoKey: "gugu91/extensions",
        issueNumber: 774,
        prNumber: 124,
        status: "pr_merged",
        url: "https://github.com/gugu91/extensions/pull/124",
        updatedAt: "2026-06-04T01:02:03.000Z",
      },
    });
  });

  it("selects repo-scoped lanes and avoids ambiguous unscoped issue collisions", () => {
    const event = buildGithubEventRelayEvent(
      { ...baseAssignment, nextStatus: "pr_open", nextPrNumber: 123 },
      "2026-06-04T01:02:03.000Z",
    )!;
    const exact = lane({
      laneId: "exact",
      metadata: { github: { owner: "gugu91", repo: "extensions" } },
    });
    const otherRepo = lane({
      laneId: "other",
      metadata: { github: { owner: "other", repo: "extensions" } },
    });
    const unscopedA = lane({ laneId: "unscoped-a" });
    const unscopedB = lane({ laneId: "unscoped-b" });

    expect(selectPinetLanesForGithubEventRelay([otherRepo, exact, unscopedA], event)).toEqual([
      exact,
    ]);
    expect(selectPinetLanesForGithubEventRelay([unscopedA], event)).toEqual([unscopedA]);
    expect(selectPinetLanesForGithubEventRelay([unscopedA, unscopedB], event)).toEqual([]);
  });

  it("resolves only safe Slack-backed relay targets", () => {
    const event = buildGithubEventRelayEvent(
      { ...baseAssignment, nextStatus: "pr_open", nextPrNumber: 123 },
      "2026-06-04T01:02:03.000Z",
    )!;
    const slackLane = lane({
      laneId: "slack",
      threadId: "123.456",
      metadata: { github: { owner: "gugu91", repo: "extensions" } },
    });
    const a2aLane = lane({ laneId: "a2a", threadId: "a2a:broker:worker" });
    const threads = new Map<string, ThreadInfo>([
      ["123.456", thread({ threadId: "123.456", source: "slack", channel: "C123" })],
      [
        "a2a:broker:worker",
        thread({ threadId: "a2a:broker:worker", source: "agent", channel: "" }),
      ],
    ]);

    expect(
      resolveSafeGithubEventRelayTarget(
        (threadId) => threads.get(threadId) ?? null,
        event,
        [a2aLane, slackLane],
        "a2a:broker:worker",
      ),
    ).toEqual({ threadId: "123.456", source: "slack", channel: "C123" });

    expect(
      resolveSafeGithubEventRelayTarget(
        (threadId) => threads.get(threadId) ?? null,
        event,
        [a2aLane],
        "a2a:broker:worker",
      ),
    ).toBeNull();
  });
});
