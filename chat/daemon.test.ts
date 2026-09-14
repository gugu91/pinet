import { describe, expect, it } from "vitest";
import { chatDaemonAddress } from "./daemon.js";

describe("chat daemon network exposure", () => {
  it("binds loopback by default and requires explicit wider exposure", () => {
    expect(chatDaemonAddress({})).toEqual({ hostname: "127.0.0.1", port: 8787 });
    expect(chatDaemonAddress({ PINET_CHAT_HOST: "0.0.0.0", PORT: "9000" })).toEqual({
      hostname: "0.0.0.0",
      port: 9000,
    });
  });
});
