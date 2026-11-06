import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

const resolvedCommands = new Map<string, string>();

/**
 * Returns the absolute path of a command on PATH, looked up once per process. Node on
 * macOS tries one posix_spawn per PATH entry before the match (nodejs/node#62554):
 * spawning `git` by name costs ~40ms instead of ~3ms on a long PATH, and far more
 * under load. Falls back to the bare name, so a missing command still fails as before.
 */
export function resolveCommand(command: string): string {
  let resolved = resolvedCommands.get(command);
  if (resolved === undefined) {
    resolved =
      (process.env.PATH ?? "")
        .split(delimiter)
        .map((dir) => join(dir, command))
        .find((candidate) => {
          try {
            accessSync(candidate, constants.X_OK);
            return statSync(candidate).isFile();
          } catch {
            return false;
          }
        }) ?? command;
    resolvedCommands.set(command, resolved);
  }
  return resolved;
}
