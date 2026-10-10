import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it, vi } from "vitest";
import { runHostCli } from "./host-cli.js";
import { readJoinProfile } from "./join-profile.js";
import { BrokerDB } from "./broker/schema.js";

it("issues protected profiles without printing credentials and revokes a host through the CLI", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pinet-host-cli-"));
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const profilePath = path.join(root, "worker.json"),
    dbPath = path.join(root, "broker.db");
  try {
    await runHostCli([
      "issue",
      "--db",
      dbPath,
      "--host",
      "host",
      "--worker",
      "worker",
      "--cwd",
      root,
      "--socket",
      path.join(root, "broker.sock"),
      "--out",
      profilePath,
    ]);
    const profile = readJoinProfile(profilePath);
    expect(fs.statSync(profilePath).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(output.mock.calls)).not.toContain(profile.credentialSecret);
    await runHostCli(["revoke", "--db", dbPath, "--host", "host"]);
    const db = new BrokerDB(dbPath);
    db.initialize();
    try {
      expect(db.membership.authenticate(profile.credentialId, profile.credentialSecret)).toBeNull();
    } finally {
      db.close();
    }
  } finally {
    output.mockRestore();
    fs.rmSync(root, { force: true, recursive: true });
  }
});
