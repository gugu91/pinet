import { describe, expect, it } from "vitest";
import { resolveHibernationSettings } from "./hibernation-config.js";

describe("hibernation settings", () => {
  it("is disabled and observe-only by default", () => {
    expect(resolveHibernationSettings({})).toMatchObject({
      enabled: false,
      mode: "observe",
      graceMs: 3_600_000,
      maxConcurrentWakes: 2,
    });
  });

  it("requires explicit enablement and preserves an allowlist", () => {
    expect(
      resolveHibernationSettings({
        hibernation: { enabled: true, mode: "manual", allowedRepos: ["gugu91/pinet"] },
      }),
    ).toMatchObject({ enabled: true, mode: "manual", allowedRepos: ["gugu91/pinet"] });
  });
});
