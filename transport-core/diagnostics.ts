export type DiagnosticLevel = "info" | "warning" | "error";
export type DiagnosticSink = (level: DiagnosticLevel, message: string) => void;

// On globalThis: hosts may load several copies of this module, and they must share one sink.
const SINK = Symbol.for("pinet.diagnosticSink");
const sinks = globalThis as typeof globalThis & { [SINK]?: DiagnosticSink };

/**
 * Routes Pinet's background diagnostics. A host that owns the terminal, such as Pi's
 * interactive TUI, must take them over: console writes would draw over its screen.
 * Pass null to restore console output.
 */
export function setDiagnosticSink(sink: DiagnosticSink | null): void {
  if (sink) sinks[SINK] = sink;
  else delete sinks[SINK];
}

export function reportDiagnostic(level: DiagnosticLevel, message: string): void {
  const sink = sinks[SINK];
  if (sink) sink(level, message);
  else if (level === "error") console.error(message);
  else if (level === "warning") console.warn(message);
  else console.info(message);
}
