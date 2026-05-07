import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { formatContext, parseNvimEvent, type EditorState, type NvimEvent } from "./helpers.js";

type NvimCommand = { type: "open_file"; file: string; line?: number };

interface RepoInfo {
  repoRoot: string;
  branch: string;
}

function resolveRepoInfo(cwd: string): RepoInfo | null {
  try {
    const repoRoot = execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf-8" }).trim();
    const branch = execSync("git branch --show-current", { cwd, encoding: "utf-8" }).trim();
    return { repoRoot, branch };
  } catch {
    return null;
  }
}

function ensureSocketDirectory(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best effort only: same-host trust is the primary boundary here.
  }
}

function tightenSocketPermissions(socketPath: string): void {
  try {
    fs.chmodSync(socketPath, 0o600);
  } catch {
    // Best effort only: keep any hardening here deliberately narrow.
  }
}

function computeSocketPath(repoInfo: RepoInfo): string {
  const key = `${repoInfo.repoRoot}:${repoInfo.branch}`;
  const hash = crypto.createHash("sha256").update(key).digest("hex");
  const dir = "/tmp/pi-nvim";
  ensureSocketDirectory(dir);
  return path.join(dir, `${hash}.sock`);
}

export default function (pi: ExtensionAPI) {
  let server: net.Server | null = null;
  let socketPath: string | null = null;
  let dirty = false;
  const clients: Set<net.Socket> = new Set();

  const editorState: EditorState = {
    file: null,
    line: null,
    visibleStart: null,
    visibleEnd: null,
    selectionStart: null,
    selectionEnd: null,
  };

  function sendJson(socket: net.Socket, payload: unknown): boolean {
    try {
      socket.write(`${JSON.stringify(payload)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  function broadcast(payload: unknown): boolean {
    if (clients.size === 0) return false;
    let sent = false;
    for (const client of clients) {
      const ok = sendJson(client, payload);
      sent = sent || ok;
    }
    return sent;
  }

  function sendToNvim(cmd: NvimCommand): boolean {
    return broadcast(cmd);
  }

  function dispatchNvimPrompt(prompt: string): boolean {
    try {
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      return true;
    } catch {
      try {
        pi.sendUserMessage(prompt, { deliverAs: "steer" });
        return true;
      } catch {
        return false;
      }
    }
  }

  function handleEvent(event: NvimEvent): void {
    switch (event.type) {
      case "buffer_focus": {
        const switchedFile = editorState.file !== event.file;
        editorState.file = event.file;
        editorState.line = event.line;

        if (switchedFile) {
          editorState.visibleStart = null;
          editorState.visibleEnd = null;
          editorState.selectionStart = null;
          editorState.selectionEnd = null;
        }

        dirty = true;
        break;
      }

      case "visible_range":
        editorState.file = event.file;
        editorState.visibleStart = event.start;
        editorState.visibleEnd = event.end;
        dirty = true;
        break;

      case "selection":
        editorState.file = event.file;
        editorState.selectionStart = event.start;
        editorState.selectionEnd = event.end;
        dirty = true;
        break;

      default:
        break;
    }
  }

  pi.registerTool({
    name: "open_in_editor",
    label: "Open in Editor",
    description: "Open a file in the user's neovim editor, optionally at a specific line",
    parameters: Type.Object({
      file: Type.String({ description: "File path (relative to repo root)" }),
      line: Type.Optional(Type.Number({ description: "Line number to jump to" })),
    }),
    async execute(_toolCallId, params) {
      const sent = sendToNvim({
        type: "open_file",
        file: params.file,
        line: params.line,
      });

      if (!sent) {
        return {
          content: [{ type: "text", text: "No neovim instance connected" }],
          isError: true,
        };
      }

      const target = params.line ? `${params.file}:${params.line}` : params.file;
      return {
        content: [{ type: "text", text: `Opened ${target} in editor` }],
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const setBridgeStatus = (healthy: boolean) => {
      ctx.ui.setStatus("nvim-bridge", healthy ? "" : "");
    };

    const repoInfo = resolveRepoInfo(ctx.cwd);

    if (!repoInfo) {
      socketPath = null;
      setBridgeStatus(false);
      return;
    }

    socketPath = computeSocketPath(repoInfo);

    try {
      fs.unlinkSync(socketPath);
    } catch {
      // Ignore if socket does not exist.
    }

    let activeConnections = 0;

    server = net.createServer((conn) => {
      activeConnections += 1;
      clients.add(conn);
      setBridgeStatus(true);

      let buffer = "";

      conn.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const parsed = JSON.parse(line) as unknown;
            const event = parseNvimEvent(parsed);
            if (!event) continue;

            if (event.type === "trigger_agent") {
              dispatchNvimPrompt(event.prompt);
            } else {
              handleEvent(event);
            }
          } catch {
            // Ignore malformed JSON.
          }
        }
      });

      conn.on("close", () => {
        clients.delete(conn);
        activeConnections = Math.max(0, activeConnections - 1);
        if (activeConnections === 0) {
          setBridgeStatus(false);
        }
      });

      conn.on("error", () => {
        // Ignore individual connection errors; close handler updates status.
      });
    });

    server.on("error", (err) => {
      console.error(`[nvim-bridge] Server error: ${err.message}`);
      setBridgeStatus(false);
    });

    server.listen(socketPath, () => {
      const activeSocketPath = socketPath;
      if (activeSocketPath) {
        tightenSocketPermissions(activeSocketPath);
      }
      setBridgeStatus(false);
    });
  });

  pi.on("before_agent_start", async () => {
    if (!dirty) return;

    const content = formatContext(editorState);
    if (!content) return;

    dirty = false;

    return {
      message: {
        customType: "nvim-context",
        content,
        display: true,
      },
    };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    for (const client of clients) {
      try {
        client.destroy();
      } catch {
        // Ignore.
      }
    }
    clients.clear();

    if (server) {
      server.close();
      server = null;
    }

    if (socketPath) {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // Ignore.
      }
      socketPath = null;
    }

    ctx.ui.setStatus("nvim-bridge", "");
  });
}
