/**
 * Parser for Amp CLI `--stream-json` output.
 *
 * `amp --execute ... --stream-json` emits one JSON object per stdout line in
 * Claude Code-compatible stream format. The worker only needs the terminal
 * `result` event, which carries the agent's final message, the Amp thread
 * (session) ID, and an error flag:
 *
 *   {"type":"result","result":"<final text>","session_id":"T-...","is_error":false,...}
 */

/** Boundary DTO for one `--stream-json` line. Fields are re-validated after parse. */
interface AmpStreamJsonLineDto {
  type?: string;
  subtype?: string;
  result?: string;
  session_id?: string;
  is_error?: boolean;
}

export interface AmpResultEvent {
  resultText: string | null;
  ampThreadId: string | null;
  isError: boolean;
}

export interface AmpStreamOutcome {
  /** Last `result` event seen, or null when the stream ended without one. */
  result: AmpResultEvent | null;
  /** Total well-formed JSON events observed (all types). */
  eventCount: number;
  /** Lines that were not valid JSON objects. */
  malformedLineCount: number;
}

/**
 * Incremental line-buffered stream parser. Feed stdout chunks with `push`,
 * call `end` once the process closes, then read `outcome`.
 */
export class AmpStreamParser {
  private buffer = "";
  private result: AmpResultEvent | null = null;
  private eventCount = 0;
  private malformedLineCount = 0;

  push(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      this.consumeLine(line);
    }
  }

  end(): void {
    const line = this.buffer;
    this.buffer = "";
    this.consumeLine(line);
  }

  get outcome(): AmpStreamOutcome {
    return {
      result: this.result,
      eventCount: this.eventCount,
      malformedLineCount: this.malformedLineCount,
    };
  }

  private consumeLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let event: AmpStreamJsonLineDto;
    try {
      const parsed = JSON.parse(trimmed) as AmpStreamJsonLineDto;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        this.malformedLineCount += 1;
        return;
      }
      event = parsed;
    } catch {
      this.malformedLineCount += 1;
      return;
    }

    this.eventCount += 1;
    if (event.type !== "result") return;

    this.result = {
      resultText: typeof event.result === "string" ? event.result : null,
      ampThreadId:
        typeof event.session_id === "string" && event.session_id.trim().length > 0
          ? event.session_id.trim()
          : null,
      isError: event.is_error === true,
    };
  }
}
