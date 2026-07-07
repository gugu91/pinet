import { describe, expect, it } from "vitest";
import { WebClient } from "@slack/web-api";

import {
  discoverMethods,
  mergeInput,
  parseCliValue,
  parseJsonObject,
  parseKeyValueArg,
  resolveMethod,
} from "./cli-helpers.ts";

describe("discoverMethods", () => {
  it("returns dot-notated method names from a WebClient", () => {
    const client = new WebClient();
    const methods = discoverMethods(client);
    expect(methods).toContain("chat.postMessage");
    expect(methods).toContain("conversations.list");
    expect(methods).toContain("auth.test");
    expect(methods.length).toBeGreaterThan(50);
  });

  it("returns a sorted list", () => {
    const client = new WebClient();
    const methods = discoverMethods(client);
    const sorted = [...methods].sort();
    expect(methods).toEqual(sorted);
  });
});

describe("resolveMethod", () => {
  it("resolves a known method to a function", () => {
    const client = new WebClient();
    const fn = resolveMethod(client, "chat.postMessage");
    expect(typeof fn).toBe("function");
  });

  it("returns null for unknown methods", () => {
    const client = new WebClient();
    expect(resolveMethod(client, "does.not.exist")).toBeNull();
    expect(resolveMethod(client, "noNamespace")).toBeNull();
  });

  it("returns null when an intermediate or final property is not callable", () => {
    const client = new WebClient();
    expect(resolveMethod(client, "chat.postMessage.nope")).toBeNull();
    expect(resolveMethod(client, "chat.nope.call")).toBeNull();
    expect(resolveMethod(client, "token.value")).toBeNull();
  });
});

describe("parseCliValue", () => {
  it("parses booleans, null, numbers, and JSON", () => {
    expect(parseCliValue("true")).toBe(true);
    expect(parseCliValue("false")).toBe(false);
    expect(parseCliValue("null")).toBeNull();
    expect(parseCliValue("42")).toBe(42);
    expect(parseCliValue("3.5")).toBe(3.5);
    expect(parseCliValue('{"ok":true}')).toEqual({ ok: true });
    expect(parseCliValue('["a",1]')).toEqual(["a", 1]);
  });

  it("preserves plain strings", () => {
    expect(parseCliValue("C123")).toBe("C123");
    expect(parseCliValue(" hello ")).toBe(" hello ");
  });
});

describe("parseKeyValueArg", () => {
  it("splits key-value pairs", () => {
    expect(parseKeyValueArg("limit=200")).toEqual({ key: "limit", value: 200 });
  });

  it("rejects malformed entries", () => {
    expect(() => parseKeyValueArg("oops")).toThrow("Expected KEY=VALUE");
  });
});

describe("parseJsonObject", () => {
  it("accepts objects and rejects arrays", () => {
    expect(parseJsonObject('{"channel":"C123"}')).toEqual({ channel: "C123" });
    expect(() => parseJsonObject("[]")).toThrow("Expected a JSON object.");
  });
});

describe("mergeInput", () => {
  it("applies later key-value pairs over base input", () => {
    expect(
      mergeInput({ channel: "C123", text: "before" }, [
        { key: "text", value: "after" },
        { key: "unfurl_links", value: false },
      ]),
    ).toEqual({
      channel: "C123",
      text: "after",
      unfurl_links: false,
    });
  });
});
