import { describe, expect, it } from "vitest";
import { AmpStreamParser } from "./amp-stream.js";

describe("AmpStreamParser", () => {
  it("extracts the terminal result event", () => {
    const parser = new AmpStreamParser();
    parser.push('{"type":"system","subtype":"init"}\n');
    parser.push(
      '{"type":"result","result":"All done.","session_id":"T-0199a1b2-0000-0000-0000-000000000000","is_error":false}\n',
    );
    parser.end();

    expect(parser.outcome).toEqual({
      result: {
        resultText: "All done.",
        ampThreadId: "T-0199a1b2-0000-0000-0000-000000000000",
        isError: false,
      },
      eventCount: 2,
      malformedLineCount: 0,
    });
  });

  it("reassembles events split across chunk boundaries", () => {
    const parser = new AmpStreamParser();
    const line = '{"type":"result","result":"split","session_id":"T-abc12345","is_error":false}';
    parser.push(line.slice(0, 17));
    parser.push(line.slice(17, 40));
    parser.push(`${line.slice(40)}\n`);
    parser.end();

    expect(parser.outcome.result?.resultText).toBe("split");
    expect(parser.outcome.malformedLineCount).toBe(0);
  });

  it("consumes a trailing line without a final newline via end()", () => {
    const parser = new AmpStreamParser();
    parser.push('{"type":"result","result":"tail","session_id":"T-abc12345","is_error":false}');
    expect(parser.outcome.result).toBeNull();
    parser.end();
    expect(parser.outcome.result?.resultText).toBe("tail");
  });

  it("counts malformed lines without aborting the stream", () => {
    const parser = new AmpStreamParser();
    parser.push("not json at all\n");
    parser.push('"just a string"\n');
    parser.push("[1,2,3]\n");
    parser.push('{"type":"result","result":"ok","session_id":"T-abc12345","is_error":false}\n');
    parser.end();

    expect(parser.outcome.malformedLineCount).toBe(3);
    expect(parser.outcome.eventCount).toBe(1);
    expect(parser.outcome.result?.resultText).toBe("ok");
  });

  it("ignores blank lines", () => {
    const parser = new AmpStreamParser();
    parser.push("\n\n  \n");
    parser.end();
    expect(parser.outcome).toEqual({ result: null, eventCount: 0, malformedLineCount: 0 });
  });

  it("keeps the last result when multiple result events appear", () => {
    const parser = new AmpStreamParser();
    parser.push('{"type":"result","result":"first","session_id":"T-abc12345","is_error":false}\n');
    parser.push('{"type":"result","result":"second","session_id":"T-abc12345","is_error":true}\n');
    parser.end();

    expect(parser.outcome.result).toEqual({
      resultText: "second",
      ampThreadId: "T-abc12345",
      isError: true,
    });
  });

  it("tolerates result events with missing fields", () => {
    const parser = new AmpStreamParser();
    parser.push('{"type":"result"}\n');
    parser.end();

    expect(parser.outcome.result).toEqual({
      resultText: null,
      ampThreadId: null,
      isError: false,
    });
  });

  it("reports no result when the stream ends without one", () => {
    const parser = new AmpStreamParser();
    parser.push('{"type":"system","subtype":"init"}\n');
    parser.push('{"type":"assistant"}\n');
    parser.end();

    expect(parser.outcome.result).toBeNull();
    expect(parser.outcome.eventCount).toBe(2);
  });
});
