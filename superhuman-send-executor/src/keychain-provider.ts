import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { ProviderPreSendRejection, type Provider, type RenderedDraft } from "./executor.js";
import { parseJson, parseRenderedDraft, parseSendResult } from "./parse.js";
const execFileAsync = promisify(execFile);
const BRIDGE = "/usr/local/libexec/pinet-superhuman-send-executor/current/credential-bridge";
const PINNED_BRIDGE_SHA256 = "REPLACE_DURING_SIGNED_RELEASE";
async function run(args: readonly string[]): Promise<string> {
  const digest = createHash("sha256")
    .update(await readFile(BRIDGE))
    .digest("hex");
  if (PINNED_BRIDGE_SHA256 === "REPLACE_DURING_SIGNED_RELEASE" || digest !== PINNED_BRIDGE_SHA256)
    throw new Error("untrusted_credential_bridge");
  const { stdout } = await execFileAsync(BRIDGE, [...args], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin" },
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });
  return stdout;
}
export class KeychainShmProvider implements Provider {
  async render(accountId: string, draftId: string): Promise<RenderedDraft> {
    return parseRenderedDraft(parseJson(await run(["render", accountId, draftId])));
  }
  async send(
    accountId: string,
    draftId: string,
    revisionId: string,
    draftFingerprint: string,
  ): Promise<{ messageId: string }> {
    try {
      return parseSendResult(
        parseJson(await run(["send", accountId, draftId, revisionId, draftFingerprint])),
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === 10)
        throw new ProviderPreSendRejection("provider_precondition_rejected");
      throw error;
    }
  }
}
