import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { Provider, RenderedDraft } from "./executor.js";
const execFileAsync = promisify(execFile);
const SHM = "/usr/local/libexec/pinet-superhuman-send-executor/shm";
const PINNED_SHM_SHA256 = "REPLACE_DURING_SIGNED_RELEASE";
async function run(args: readonly string[]): Promise<object> {
  const digest = createHash("sha256")
    .update(await readFile(SHM))
    .digest("hex");
  if (PINNED_SHM_SHA256 === "REPLACE_DURING_SIGNED_RELEASE" || digest !== PINNED_SHM_SHA256)
    throw new Error("untrusted_shm_binary");
  const { stdout: credentialOutput } = await execFileAsync(
    "/usr/bin/security",
    ["find-generic-password", "-w", "-s", "ai.pinet.superhuman-send-executor", "-a", "root"],
    { encoding: "utf8", maxBuffer: 64 * 1024 },
  );
  const token = credentialOutput.trim();
  const { stdout } = await execFileAsync(SHM, [...args], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", SHM_AUTH_TOKEN: token },
    maxBuffer: 1024 * 1024,
  });
  const parsed: object = JSON.parse(stdout) as object;
  return parsed;
}
export class KeychainShmProvider implements Provider {
  async render(accountId: string, draftId: string): Promise<RenderedDraft> {
    return (await run([
      "draft",
      "get",
      "--account",
      accountId,
      "--id",
      draftId,
      "--json",
    ])) as RenderedDraft;
  }
  async send(accountId: string, draftId: string): Promise<{ messageId: string }> {
    return (await run(["draft", "send", "--account", accountId, "--id", draftId, "--json"])) as {
      messageId: string;
    };
  }
}
