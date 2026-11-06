import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

const resolvedCommands = new Map<string, string>();

/**
 * Returns the absolute path Node would spawn for a bare command name. Node on macOS tries one
 * posix_spawn per PATH entry before the match (nodejs/node#62554): spawning `git` by name costs
 * ~40ms instead of ~3ms on a long PATH, and far more under load. Lookups are cached per PATH.
 * Windows, explicit paths and relative PATH entries (resolved against the child's cwd) are left
 * to Node, as is a command that is not found, so it still fails as before.
 */
export function resolveCommand(command: string): string {
  const path = process.env.PATH ?? "";
  const directories = path.split(delimiter);
  if (
    process.platform === "win32" ||
    command.includes("/") ||
    !directories.every((directory) => isAbsolute(directory))
  ) {
    return command;
  }
  const key = `${path}\0${command}`;
  let resolved = resolvedCommands.get(key);
  if (resolved === undefined) {
    resolved =
      directories
        .map((directory) => join(directory, command))
        .find((candidate) => {
          try {
            accessSync(candidate, constants.X_OK);
            return statSync(candidate).isFile();
          } catch {
            return false;
          }
        }) ?? command;
    resolvedCommands.set(key, resolved);
  }
  return resolved;
}
