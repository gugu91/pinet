import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  joinClientOptions,
  joinIdentity,
  readJoinProfile,
  writeJoinProfile,
  type JoinProfile,
} from "./join-profile.js";
import { assertPrivateTcpHost } from "./broker/private-network.js";

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { force: true, recursive: true }));
});
const profile: JoinProfile = {
  version: 1,
  endpoint: { host: "100.71.239.22", port: 9012, privateNetwork: true },
  credentialId: "credential",
  credentialSecret: "secret",
  hostId: "host",
  workerId: "worker",
  repos: ["/tmp"],
  capabilities: ["test"],
};

describe("protected join profiles", () => {
  it("round-trips owner-only files and refuses overwrite, open permissions and symlinks", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinet-profile-"));
    dirs.push(dir);
    const filename = path.join(dir, "worker.json");
    writeJoinProfile(filename, profile);
    expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
    expect(readJoinProfile(filename)).toEqual(profile);
    expect(joinClientOptions(profile)).toMatchObject({
      host: "100.71.239.22",
      credentialId: "credential",
    });
    expect(joinIdentity(profile)).toBe("host:worker:worker");
    expect(() => writeJoinProfile(filename, profile)).toThrow();
    fs.chmodSync(filename, 0o644);
    expect(() => readJoinProfile(filename)).toThrow("owner-only");
    fs.chmodSync(filename, 0o600);
    fs.symlinkSync(filename, path.join(dir, "link"));
    expect(() => readJoinProfile(path.join(dir, "link"))).toThrow();
  });

  it("rejects malformed boundary data and public endpoints", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pinet-profile-"));
    dirs.push(dir);
    const filename = path.join(dir, "worker.json");
    fs.writeFileSync(filename, JSON.stringify({ ...profile, workerId: 5 }), { mode: 0o600 });
    expect(() => readJoinProfile(filename)).toThrow("Invalid Pinet join profile");
    fs.writeFileSync(filename, '{"credentialSecret":"must-not-leak",');
    expect(() => readJoinProfile(filename)).toThrow("Invalid JSON in Pinet join profile.");
    fs.writeFileSync(
      filename,
      JSON.stringify({
        ...profile,
        endpoint: { host: "8.8.8.8", port: 9012, privateNetwork: true },
      }),
    );
    expect(() => readJoinProfile(filename)).toThrow("public/wildcard");
  });

  it("keeps local defaults, requires private opt-in, rejects DNS and wildcard binds", () => {
    expect(() => assertPrivateTcpHost("127.0.0.1", false)).not.toThrow();
    expect(() => assertPrivateTcpHost("100.71.239.22", true)).not.toThrow();
    for (const host of ["0.0.0.0", "::", "8.8.8.8", "some-host.ts.net"])
      expect(() => assertPrivateTcpHost(host, true)).toThrow();
    expect(() => assertPrivateTcpHost("192.168.1.77", false)).toThrow();
  });
});
