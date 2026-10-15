import * as fs from "node:fs";

/** What `pi --pinet-join <file>` needs to follow a broker under a worker key. */
export interface JoinFile {
  socket: string;
  key: string;
}

/** Reads a join file, refusing one that other users can read: it holds a bearer key. */
export function readJoinFile(filePath: string): JoinFile {
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
      throw new Error(`${filePath} must be a file only you can read (chmod 600).`);
    }
    const parsed = JSON.parse(fs.readFileSync(fd, "utf8")) as Partial<JoinFile> & {
      version?: number;
    };
    if (
      parsed.version !== 1 ||
      typeof parsed.socket !== "string" ||
      typeof parsed.key !== "string"
    ) {
      throw new Error(`${filePath} must contain {"version": 1, "socket": "...", "key": "..."}.`);
    }
    return { socket: parsed.socket, key: parsed.key };
  } finally {
    fs.closeSync(fd);
  }
}

/** Creates an owner-only join file; never overwrites an existing one. */
export function writeJoinFile(filePath: string, join: JoinFile): void {
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, ...join }, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
}
