import { describe, expect, it } from "vitest";
import { normalizePinetOutputOptions } from "./output-options.js";

describe("normalizePinetOutputOptions", () => {
  it("defaults to compact CLI output", () => {
    expect(normalizePinetOutputOptions({})).toEqual({ format: "cli", full: false });
  });

  it("accepts explicit JSON aliases", () => {
    expect(normalizePinetOutputOptions({ format: "json" })).toEqual({
      format: "json",
      full: false,
    });
    expect(normalizePinetOutputOptions({ f: "json" })).toEqual({ format: "json", full: false });
    expect(normalizePinetOutputOptions({ "-f": "json" })).toEqual({
      format: "json",
      full: false,
    });
  });

  it("accepts explicit full aliases", () => {
    expect(normalizePinetOutputOptions({ full: true })).toEqual({ format: "cli", full: true });
    expect(normalizePinetOutputOptions({ "--full": true })).toEqual({
      format: "cli",
      full: true,
    });
  });

  it("rejects invalid output controls", () => {
    expect(() => normalizePinetOutputOptions({ format: "yaml" })).toThrow(
      'format must be "cli" or "json".',
    );
    expect(() => normalizePinetOutputOptions({ "-f": 7 })).toThrow(
      'format must be "cli" or "json".',
    );
    expect(() => normalizePinetOutputOptions({ full: "true" })).toThrow(
      "full must be a boolean when provided.",
    );
    expect(() => normalizePinetOutputOptions({ "--full": 1 })).toThrow(
      "full must be a boolean when provided.",
    );
  });
});
