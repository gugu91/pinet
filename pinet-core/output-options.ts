export type PinetOutputFormat = "cli" | "json";

type PinetOutputFormatInput = string | number | boolean | null | undefined;
type PinetOutputFullInput = boolean | string | number | null | undefined;

export interface PinetOutputOptionsArgs {
  format?: PinetOutputFormatInput;
  f?: PinetOutputFormatInput;
  "-f"?: PinetOutputFormatInput;
  full?: PinetOutputFullInput;
  "--full"?: PinetOutputFullInput;
}

export interface PinetOutputOptions {
  format: PinetOutputFormat;
  full: boolean;
}

export function normalizePinetOutputOptions(args: PinetOutputOptionsArgs): PinetOutputOptions {
  const rawFormat = args.format ?? args.f ?? args["-f"];
  const format = rawFormat == null ? "cli" : String(rawFormat).trim().toLowerCase();
  if (format !== "cli" && format !== "json") {
    throw new Error('format must be "cli" or "json".');
  }

  const rawFull = args.full ?? args["--full"];
  if (rawFull != null && typeof rawFull !== "boolean") {
    throw new Error("full must be a boolean when provided.");
  }

  return { format, full: rawFull === true };
}
