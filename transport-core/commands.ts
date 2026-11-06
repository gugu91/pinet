import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";

const resolvedCommands = new Map<string, string>();

/**
 * Returns the path Node would spawn for a bare command name, given the child's cwd. Node on
 * macOS tries one posix_spawn per PATH entry before the match (nodejs/node#62554): spawning
 * `git` by name costs ~40ms instead of ~3ms on a long PATH, and far more under load. Lookups
 * are cached per cwd and PATH. Windows and explicit paths are left to Node, as is a command
 * that is not found, so it still fails as before.
 */
export function resolveCommand(command: string, cwd = process.cwd()): string {
  if (process.platform === "win32" || command.includes("/")) return command;
  const path = process.env.PATH ?? "";
  const key = `${cwd}\0${path}\0${command}`;
  let resolved = resolvedCommands.get(key);
  if (resolved === undefined) {
    resolved =
      path
        .split(delimiter)
        // Like the child's exec: relative and empty entries are relative to its cwd.
        .map((directory) => resolve(cwd, directory, command))
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
