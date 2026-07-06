import { describe, expect, it } from "vitest";
import { interpretWaiterResponse } from "./waiter.js";

describe("interpretWaiterResponse", () => {
  it("reports pending messages with summaries", () => {
    const outcome = interpretWaiterResponse(
      JSON.stringify({ pending: 2, summaries: ["Lion: hi", "Crane: task"] }),
    );
    expect(outcome.kind).toBe("messages");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.text).toContain("2 mesh message(s) pending");
    expect(outcome.text).toContain("Lion: hi");
    expect(outcome.text).toContain("pinet_read");
  });

  it("reports exit and forbids re-arming", () => {
    const outcome = interpretWaiterResponse(JSON.stringify({ exit: true }));
    expect(outcome.kind).toBe("exit");
    expect(outcome.text).toContain("Do not re-arm");
    expect(outcome.exitCode).toBe(0);
  });

  it("treats unparseable responses as bridge failure", () => {
    const outcome = interpretWaiterResponse("not json");
    expect(outcome.kind).toBe("bridge-gone");
    expect(outcome.exitCode).toBe(1);
  });
});
