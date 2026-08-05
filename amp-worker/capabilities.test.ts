import { describe, expect, it } from "vitest";
import { buildAmpWorkerCapabilities } from "./capabilities.js";

describe("buildAmpWorkerCapabilities", () => {
  it("advertises the Amp harness surface with explicit semantics", () => {
    const capabilities = buildAmpWorkerCapabilities({ adapterVersion: "1.2.3", mode: "high" });
    expect(capabilities).toMatchObject({
      role: "worker",
      harness: "amp",
      adapter: "amp-worker",
      adapterVersion: "1.2.3",
      mode: "high",
      steer: "next-safe-boundary",
      interrupt: "sigterm-owned-process",
      reload: "reregister-metadata",
      exit: true,
    });
    expect(capabilities.modes).toEqual(["low", "medium", "high", "ultra"]);
  });

  it("declares subtree spawning unavailable with a reason instead of pretending parity", () => {
    const capabilities = buildAmpWorkerCapabilities({ adapterVersion: "1.2.3", mode: "medium" });
    expect(capabilities.subtree.spawn).toBe(false);
    expect(capabilities.subtree.reason).toMatch(/no broker-callable child-thread API/i);
    expect(capabilities.subtree.adapter).toBe("amp-worker");
    expect(capabilities.subtree.adapterVersion).toBe("1.2.3");
  });
});
