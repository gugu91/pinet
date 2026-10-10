import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { probeGitContext } from "./git-metadata.js";

export const DEFAULT_BROKER_PROMPT_MAX_BYTES = 64 * 1024;

export type BrokerPromptSource = "configured" | "workspace" | "user" | "packaged";

export interface BrokerPromptWarning {
  source: BrokerPromptSource;
  reason: "unsafe_path" | "unreadable" | "too_large" | "invalid_utf8" | "empty";
  message: string;
}

export interface BrokerPromptCandidate {
  source: BrokerPromptSource;
  path: string;
  root: string;
  required: boolean;
}

export interface BrokerPromptLoadOptions {
  workspaceRoot?: string;
  cwd?: string;
  homeDir?: string;
  defaultPromptPath?: string;
  configuredPrompt?: string;
  maxBytes?: number;
}

export interface BrokerPromptLoadResult {
  source: BrokerPromptSource;
  content: string;
  warnings: BrokerPromptWarning[];
  diagnostic: string;
}

export interface BrokerPromptTemplateValues {
  agentEmoji: string;
  agentName: string;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function isWithinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function describeSource(source: BrokerPromptSource): string {
  switch (source) {
    case "configured":
      return "configured prompt";
    case "workspace":
      return "workspace override";
    case "user":
      return "user-local override";
    case "packaged":
      return "packaged default";
  }
}

function warning(
  source: BrokerPromptSource,
  reason: BrokerPromptWarning["reason"],
  detail: string,
): BrokerPromptWarning {
  return {
    source,
    reason,
    message: `broker prompt: ${describeSource(source)} rejected (${detail}); continuing`,
  };
}

function resolveConfiguredBrokerPromptCandidate(
  configuredPrompt: string | undefined,
  options: { workspaceRoot: string; homeDir: string },
): BrokerPromptCandidate | null {
  const prompt = configuredPrompt?.trim();
  if (!prompt) {
    return null;
  }

  const hasPathSyntax =
    prompt.startsWith(".") ||
    prompt.startsWith("~") ||
    path.isAbsolute(prompt) ||
    prompt.includes("/") ||
    prompt.includes(path.sep);
  if (!hasPathSyntax) {
    const presetFile = prompt.endsWith(".md") ? prompt : `${prompt}.md`;
    const presetPath = path.resolve(moduleDir, "prompts", "broker", presetFile);
    return {
      source: "configured",
      path: presetPath,
      root: path.resolve(path.dirname(path.dirname(path.dirname(presetPath)))),
      required: true,
    };
  }

  const expandedPath = prompt.startsWith("~/")
    ? path.join(options.homeDir, prompt.slice(2))
    : prompt;
  const resolvedPath = path.isAbsolute(expandedPath)
    ? path.resolve(expandedPath)
    : path.resolve(options.workspaceRoot, expandedPath);
  return {
    source: "configured",
    path: resolvedPath,
    root: path.isAbsolute(expandedPath) ? path.dirname(resolvedPath) : options.workspaceRoot,
    required: true,
  };
}

export function resolveBrokerPromptCandidates(
  options: BrokerPromptLoadOptions = {},
): BrokerPromptCandidate[] {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? options.cwd ?? process.cwd());
  const homeDir = path.resolve(options.homeDir ?? process.env.HOME ?? "");
  const userRoot = path.join(homeDir, ".pi", "agent", "slack-bridge");
  const defaultPromptPath = path.resolve(
    options.defaultPromptPath ?? path.join(moduleDir, "prompts", "broker", "default.md"),
  );
  const defaultRoot = path.resolve(path.dirname(path.dirname(path.dirname(defaultPromptPath))));
  const packagedCandidates: BrokerPromptCandidate[] = [
    {
      source: "packaged",
      path: defaultPromptPath,
      root: defaultRoot,
      required: true,
    },
  ];
  const configuredCandidate = resolveConfiguredBrokerPromptCandidate(options.configuredPrompt, {
    workspaceRoot,
    homeDir,
  });

  return [
    ...(configuredCandidate ? [configuredCandidate] : []),
    {
      source: "workspace",
      path: path.join(workspaceRoot, ".pi", "slack-bridge", "tmux.md"),
      root: workspaceRoot,
      required: false,
    },
    {
      source: "user",
      path: path.join(userRoot, "tmux.md"),
      root: userRoot,
      required: false,
    },
    ...packagedCandidates,
  ];
}

async function readValidCandidate(
  candidate: BrokerPromptCandidate,
  maxBytes: number,
): Promise<{ content: string } | { warning: BrokerPromptWarning } | null> {
  let realRoot: string;
  let realPath: string;
  try {
    realRoot = await fs.realpath(candidate.root);
    realPath = await fs.realpath(candidate.path);
  } catch (error) {
    if (!candidate.required && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    return { warning: warning(candidate.source, "unreadable", "unreadable") };
  }

  if (!isWithinRoot(realPath, realRoot)) {
    return { warning: warning(candidate.source, "unsafe_path", "path escapes allowed root") };
  }

  let stat;
  try {
    stat = await fs.stat(realPath);
  } catch {
    return { warning: warning(candidate.source, "unreadable", "unreadable") };
  }

  if (!stat.isFile()) {
    return { warning: warning(candidate.source, "unreadable", "not a regular file") };
  }

  if (stat.size > maxBytes) {
    return { warning: warning(candidate.source, "too_large", `over ${maxBytes} bytes`) };
  }

  let data: Buffer;
  try {
    data = await fs.readFile(realPath);
  } catch {
    return { warning: warning(candidate.source, "unreadable", "unreadable") };
  }

  let content: string;
  try {
    content = decoder.decode(data);
  } catch {
    return { warning: warning(candidate.source, "invalid_utf8", "invalid UTF-8") };
  }

  if (content.includes("\0")) {
    return { warning: warning(candidate.source, "invalid_utf8", "binary-looking content") };
  }

  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return { warning: warning(candidate.source, "empty", "empty file") };
  }

  return { content: trimmed };
}

async function resolveDefaultWorkspaceRoot(options: BrokerPromptLoadOptions): Promise<string> {
  if (options.workspaceRoot) {
    return path.resolve(options.workspaceRoot);
  }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const gitContext = await probeGitContext(cwd);
  return path.resolve(gitContext.repoRoot ?? cwd);
}

export async function loadBrokerPrompt(
  options: BrokerPromptLoadOptions = {},
): Promise<BrokerPromptLoadResult> {
  const warnings: BrokerPromptWarning[] = [];
  const maxBytes = options.maxBytes ?? DEFAULT_BROKER_PROMPT_MAX_BYTES;
  const workspaceRoot = await resolveDefaultWorkspaceRoot(options);

  for (const candidate of resolveBrokerPromptCandidates({ ...options, workspaceRoot })) {
    const result = await readValidCandidate(candidate, maxBytes);
    if (result === null) {
      continue;
    }
    if ("warning" in result) {
      warnings.push(result.warning);
      continue;
    }
    return {
      source: candidate.source,
      content: result.content,
      warnings,
      diagnostic: `broker prompt: ${describeSource(candidate.source)} loaded`,
    };
  }

  throw new Error(
    "No valid broker prompt candidates found; packaged default is missing or invalid.",
  );
}

export function renderBrokerPromptContent(
  content: string,
  values: BrokerPromptTemplateValues,
): string {
  return content
    .replaceAll("{{agentEmoji}}", values.agentEmoji)
    .replaceAll("{{agentName}}", values.agentName);
}
