import { describe, expect, it } from "vitest";
import {
  INITIAL_RECONNECT_DELAY_MS,
  MAX_RECONNECT_DELAY_MS,
  computeReconnectDelay,
  splitJsonRpcLines,
} from "./broker-client.js";

describe("splitJsonRpcLines", () => {
  it("returns complete lines and keeps the partial tail", () => {
    const { lines, rest } = splitJsonRpcLines('{"id":1}\n{"id":2}\n{"id":3');
    expect(lines).toEqual(['{"id":1}', '{"id":2}']);
    expect(rest).toBe('{"id":3');
  });

  it("skips blank lines", () => {
    const { lines, rest } = splitJsonRpcLines('\n\n{"id":1}\n\n');
    expect(lines).toEqual(['{"id":1}']);
    expect(rest).toBe("");
  });
});

describe("computeReconnectDelay", () => {
  it("backs off exponentially from the initial delay", () => {
    expect(computeReconnectDelay(0)).toBe(INITIAL_RECONNECT_DELAY_MS);
    expect(computeReconnectDelay(1)).toBe(INITIAL_RECONNECT_DELAY_MS * 2);
  });

  it("caps at the max delay", () => {
    expect(computeReconnectDelay(20)).toBe(MAX_RECONNECT_DELAY_MS);
  });
});
