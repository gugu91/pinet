import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GitContext } from "./git-metadata.js";
import {
  buildAllowlist,
  buildIdentityReplyGuidelines,
  buildPinetOwnerToken,
  buildPinetSkinAssignment,
  buildSlackCompatibilityScope,
  getSlackUserAccessWarning,
  isUserAllowed as checkUserAllowed,
  loadSettings as loadSettingsFromFile,
  normalizeOwnedThreads,
  normalizePinetSkinTheme,
  resolveRuntimeAgentIdentity,
  shortenPath,
  type PinetSkinStatusVocabulary,
  type SlackBridgeSettings,
} from "./helpers.js";
import {
  buildSecurityPrompt,
  getEmptyRuntimeGuardrailsWarning,
  type SecurityGuardrails,
} from "./guardrails.js";
import { resolveReactionCommands } from "./reaction-triggers.js";
import type { SinglePlayerThreadInfo } from "./single-player-runtime.js";

export type RuntimeAgentRole = "broker" | "worker";
export type ReactionCommandMap = Map<string, { action: string; prompt: string }>;

export interface ReloadableRuntimeSnapshot {
  settings: SlackBridgeSettings;
  botToken: string | undefined;
  appToken: string | undefined;
  allowedUsers: Set<string> | null;
  guardrails: SecurityGuardrails;
  reactionCommands: ReactionCommandMap;
  securityPrompt: string;
  agentName: string;
  agentEmoji: string;
  activeSkinTheme: string | null;
  agentPersonality: string | null;
  agentAliases: string[];
}

export interface RuntimeAgentContextDeps {
  cwd: string;
  getSettings: () => SlackBridgeSettings;
  setSettings: (settings: SlackBridgeSettings) => void;
  getBotToken: () => string | undefined;
  setBotToken: (token: string | undefined) => void;
  getAppToken: () => string | undefined;
  setAppToken: (token: string | undefined) => void;
  getAllowedUsers: () => Set<string> | null;
  setAllowedUsers: (users: Set<string> | null) => void;
  getGuardrails: () => SecurityGuardrails;
  setGuardrails: (guardrails: SecurityGuardrails) => void;
  getReactionCommands: () => ReactionCommandMap;
  setReactionCommands: (commands: ReactionCommandMap) => void;
  getSecurityPrompt: () => string;
  setSecurityPrompt: (prompt: string) => void;
  getAgentName: () => string;
  setAgentName: (name: string) => void;
  getAgentEmoji: () => string;
  setAgentEmoji: (emoji: string) => void;
  getAgentStableId: () => string;
  getBrokerStableId: () => string;
  getBrokerRole: () => "broker" | "follower" | null;
  getAgentOwnerToken: () => string;
  setAgentOwnerToken: (ownerToken: string) => void;
  getActiveSkinTheme: () => string | null;
  setActiveSkinTheme: (theme: string | null) => void;
  getAgentPersonality: () => string | null;
  setAgentPersonality: (personality: string | null) => void;
  getAgentAliases: () => Set<string>;
  getThreads: () => Map<string, SinglePlayerThreadInfo>;
  getExtensionContext: () => ExtensionContext | null;
  persistState: () => void;
  updateBadge: () => void;
  getGitContext: () => Promise<GitContext>;
}

export interface RuntimeAgentContext {
  isUserAllowed: (userId: string) => boolean;
  maybeWarnSlackUserAccess: (ctx?: ExtensionContext) => void;
  maybeWarnSlackGuardrailPosture: (ctx?: ExtensionContext) => void;
  getStableIdForRole: (role: RuntimeAgentRole) => string;
  getIdentitySeedForRole: (role: RuntimeAgentRole, sessionFile?: string) => string;
  getSkinSeed: (preferredSeed?: string) => string;
  rememberAgentAlias: (name: string | undefined) => void;
  resolveSkinAssignment: (
    role: RuntimeAgentRole,
    seed?: string,
  ) => {
    name: string;
    emoji: string;
    personality: string;
    statusVocabulary?: PinetSkinStatusVocabulary;
  } | null;
  applyLocalAgentIdentity: (
    nextName: string,
    nextEmoji: string,
    nextPersonality: string | null,
  ) => void;
  refreshSettings: () => void;
  snapshotReloadableRuntime: () => ReloadableRuntimeSnapshot;
  restoreReloadableRuntime: (snapshot: ReloadableRuntimeSnapshot) => void;
  detectProjectTools: (repoRoot: string, cwd: string) => string[];
  getAgentMetadata: (role?: RuntimeAgentRole) => Promise<Record<string, unknown>>;
  asStringValue: (value: unknown) => string | undefined;
  getMeshRoleFromMetadata: (
    metadata: Record<string, unknown> | undefined,
    fallback?: RuntimeAgentRole,
  ) => RuntimeAgentRole;
  buildSkinMetadata: (
    metadata: Record<string, unknown> | undefined,
    personality: string,
    statusVocabulary?: PinetSkinStatusVocabulary,
  ) => Record<string, unknown>;
  getIdentityGuidelines: () => [string, string, string];
  applyRegistrationIdentity: (registration: {
    name: string;
    emoji: string;
    metadata?: Record<string, unknown> | null;
  }) => void;
}

export function createRuntimeAgentContext(deps: RuntimeAgentContextDeps): RuntimeAgentContext {
  let lastSlackUserAccessWarning = "";
  let lastSlackGuardrailPostureWarning = "";
  const selfLocation = `${shortenPath(deps.cwd, os.homedir())}@${os.hostname()}`;

  function isUserAllowed(userId: string): boolean {
    return checkUserAllowed(deps.getAllowedUsers(), userId);
  }

  function maybeWarnSlackUserAccess(ctx?: ExtensionContext): void {
    const warning = getSlackUserAccessWarning(deps.getAllowedUsers());
    if (!warning) {
      lastSlackUserAccessWarning = "";
      return;
    }
    if (warning === lastSlackUserAccessWarning) {
      return;
    }
    lastSlackUserAccessWarning = warning;
    console.warn(`[slack-bridge] ${warning}`);
    ctx?.ui.notify(warning, "warning");
  }

  function maybeWarnSlackGuardrailPosture(ctx?: ExtensionContext): void {
    const botToken = deps.getBotToken()?.trim();
    const appToken = deps.getAppToken()?.trim();
    const allowlist = deps.getAllowedUsers();
    const hasAdmittedUsers = allowlist === null || allowlist.size > 0;
    const warning =
      botToken && appToken && hasAdmittedUsers
        ? getEmptyRuntimeGuardrailsWarning(deps.getGuardrails())
        : null;

    if (!warning) {
      lastSlackGuardrailPostureWarning = "";
      return;
    }
    if (warning === lastSlackGuardrailPostureWarning) {
      return;
    }

    lastSlackGuardrailPostureWarning = warning;
    console.warn(`[slack-bridge] ${warning}`);
    ctx?.ui.notify(warning, "warning");
  }

  function getStableIdForRole(role: RuntimeAgentRole): string {
    return role === "broker" ? deps.getBrokerStableId() : deps.getAgentStableId();
  }

  function getIdentitySeedForRole(
    role: RuntimeAgentRole,
    sessionFile = deps.getExtensionContext()?.sessionManager.getSessionFile() ?? undefined,
  ): string {
    return role === "broker" ? deps.getBrokerStableId() : (sessionFile ?? deps.getAgentStableId());
  }

  function getSkinSeed(preferredSeed?: string): string {
    return (
      preferredSeed?.trim() ||
      getStableIdForRole(deps.getBrokerRole() === "broker" ? "broker" : "worker")
    );
  }

  function rememberAgentAlias(name: string | undefined): void {
    const trimmed = name?.trim();
    if (!trimmed || trimmed === deps.getAgentName()) {
      return;
    }

    const agentAliases = deps.getAgentAliases();
    agentAliases.add(trimmed);
    while (agentAliases.size > 24) {
      const oldest = agentAliases.values().next().value;
      if (!oldest) {
        break;
      }
      agentAliases.delete(oldest);
    }
  }

  function resolveSkinAssignment(
    role: RuntimeAgentRole,
    seed = getSkinSeed(),
  ): {
    name: string;
    emoji: string;
    personality: string;
    statusVocabulary?: PinetSkinStatusVocabulary;
  } | null {
    const activeSkinTheme = deps.getActiveSkinTheme();
    if (!activeSkinTheme) {
      return null;
    }

    const assignment = buildPinetSkinAssignment({ theme: activeSkinTheme, role, seed });
    return {
      name: assignment.name,
      emoji: assignment.emoji,
      personality: assignment.personality,
      statusVocabulary: assignment.statusVocabulary,
    };
  }

  function applyLocalAgentIdentity(
    nextName: string,
    nextEmoji: string,
    nextPersonality: string | null,
  ): void {
    const previousName = deps.getAgentName();
    if (
      previousName === nextName &&
      deps.getAgentEmoji() === nextEmoji &&
      (deps.getAgentPersonality() ?? null) === (nextPersonality ?? null)
    ) {
      return;
    }

    deps.setAgentName(nextName);
    deps.setAgentEmoji(nextEmoji);
    deps.setAgentPersonality(nextPersonality ?? null);
    rememberAgentAlias(previousName);
    normalizeOwnedThreads(
      deps.getThreads().values(),
      deps.getAgentName(),
      deps.getAgentOwnerToken(),
      deps.getAgentAliases(),
    );
    deps.persistState();
    deps.updateBadge();
  }

  function refreshSettings(): void {
    const settings = loadSettingsFromFile();
    deps.setSettings(settings);
    deps.setBotToken(settings.botToken ?? process.env.SLACK_BOT_TOKEN);
    deps.setAppToken(settings.appToken ?? process.env.SLACK_APP_TOKEN);
    deps.setAllowedUsers(
      buildAllowlist(
        settings,
        process.env.SLACK_ALLOWED_USERS,
        process.env.SLACK_ALLOW_ALL_WORKSPACE_USERS,
      ),
    );
    const guardrails = settings.security ?? {};
    deps.setGuardrails(guardrails);
    deps.setReactionCommands(resolveReactionCommands(settings.reactionCommands));
    deps.setSecurityPrompt(buildSecurityPrompt(guardrails));
    const configuredSkinTheme = normalizePinetSkinTheme(settings.skinTheme);
    deps.setActiveSkinTheme(configuredSkinTheme);

    const role = deps.getBrokerRole() === "broker" ? "broker" : "worker";
    const identitySeed = getIdentitySeedForRole(role);
    const skinIdentity = resolveSkinAssignment(role, identitySeed);
    if (skinIdentity) {
      deps.setAgentName(skinIdentity.name);
      deps.setAgentEmoji(skinIdentity.emoji);
      deps.setAgentPersonality(skinIdentity.personality);
      return;
    }

    const refreshedIdentity = resolveRuntimeAgentIdentity(
      { name: deps.getAgentName(), emoji: deps.getAgentEmoji() },
      settings,
      process.env.PI_NICKNAME,
      identitySeed,
      role,
    );
    deps.setAgentName(refreshedIdentity.name);
    deps.setAgentEmoji(refreshedIdentity.emoji);
    deps.setAgentPersonality(null);
  }

  function snapshotReloadableRuntime(): ReloadableRuntimeSnapshot {
    return {
      settings: structuredClone(deps.getSettings()),
      botToken: deps.getBotToken(),
      appToken: deps.getAppToken(),
      allowedUsers: deps.getAllowedUsers() ? new Set(deps.getAllowedUsers()) : null,
      guardrails: structuredClone(deps.getGuardrails()),
      reactionCommands: new Map(deps.getReactionCommands()),
      securityPrompt: deps.getSecurityPrompt(),
      agentName: deps.getAgentName(),
      agentEmoji: deps.getAgentEmoji(),
      activeSkinTheme: deps.getActiveSkinTheme(),
      agentPersonality: deps.getAgentPersonality(),
      agentAliases: [...deps.getAgentAliases()],
    };
  }

  function restoreReloadableRuntime(snapshot: ReloadableRuntimeSnapshot): void {
    deps.setSettings(structuredClone(snapshot.settings));
    deps.setBotToken(snapshot.botToken);
    deps.setAppToken(snapshot.appToken);
    deps.setAllowedUsers(snapshot.allowedUsers ? new Set(snapshot.allowedUsers) : null);
    deps.setGuardrails(structuredClone(snapshot.guardrails));
    deps.setReactionCommands(new Map(snapshot.reactionCommands));
    deps.setSecurityPrompt(snapshot.securityPrompt);
    deps.setAgentName(snapshot.agentName);
    deps.setAgentEmoji(snapshot.agentEmoji);
    deps.setActiveSkinTheme(snapshot.activeSkinTheme);
    deps.setAgentPersonality(snapshot.agentPersonality);
    deps.setAgentOwnerToken(
      buildPinetOwnerToken(
        getStableIdForRole(deps.getBrokerRole() === "broker" ? "broker" : "worker"),
      ),
    );

    const agentAliases = deps.getAgentAliases();
    agentAliases.clear();
    for (const alias of snapshot.agentAliases) {
      if (alias && alias !== deps.getAgentName()) {
        agentAliases.add(alias);
      }
    }
  }

  function detectProjectTools(repoRoot: string, cwd: string): string[] {
    const tools = new Set<string>();

    for (const candidate of [path.join(cwd, "package.json"), path.join(repoRoot, "package.json")]) {
      try {
        if (!fs.existsSync(candidate)) {
          continue;
        }
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf-8")) as {
          scripts?: Record<string, string>;
        };
        const scripts = parsed.scripts ?? {};
        if (scripts.test) tools.add("test");
        if (scripts.lint) tools.add("lint");
        if (scripts.typecheck) tools.add("typecheck");
        if (scripts.build) tools.add("build");
      } catch {
        // Ignore unreadable package.json files.
      }
    }

    tools.add("git");
    return [...tools].sort();
  }

  async function getAgentMetadata(
    role: RuntimeAgentRole = "worker",
  ): Promise<Record<string, unknown>> {
    const gitContext = await deps.getGitContext();
    const { cwd, repo, repoRoot, branch } = gitContext;
    const resolvedRepoRoot = repoRoot ?? cwd;
    const tools = detectProjectTools(resolvedRepoRoot, cwd);
    const scope = buildSlackCompatibilityScope();
    const tags = [
      `role:${role}`,
      `repo:${repo}`,
      ...(branch ? [`branch:${branch}`] : []),
      ...(scope.workspace?.provider ? [`scope-provider:${scope.workspace.provider}`] : []),
      ...(scope.workspace?.compatibilityKey ? [`scope:${scope.workspace.compatibilityKey}`] : []),
      ...tools.map((tool) => `tool:${tool}`),
    ];

    const skinAssignment = resolveSkinAssignment(role, getIdentitySeedForRole(role));
    const brokerManaged = role === "worker" && process.env.PINET_BROKER_MANAGED === "1";
    const brokerManagedMetadata = brokerManaged
      ? {
          brokerManaged: true,
          brokerManagedBy: process.env.PINET_BROKER_AGENT_ID?.trim() || undefined,
          launchSource: process.env.PINET_LAUNCH_SOURCE?.trim() || "broker-tmux",
          tmuxSession: process.env.PINET_TMUX_SESSION?.trim() || undefined,
          brokerManagedAt: new Date().toISOString(),
        }
      : {};

    return {
      cwd,
      branch,
      host: os.hostname(),
      role,
      repo,
      repoRoot,
      scope,
      ...brokerManagedMetadata,
      ...(deps.getActiveSkinTheme() ? { skinTheme: deps.getActiveSkinTheme() } : {}),
      ...(deps.getAgentPersonality() ? { personality: deps.getAgentPersonality() } : {}),
      ...(skinAssignment?.statusVocabulary
        ? { skinStatusVocabulary: skinAssignment.statusVocabulary }
        : {}),
      capabilities: {
        repo,
        repoRoot,
        branch,
        role,
        tools,
        tags,
        scope,
      },
    };
  }

  function asStringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  }

  function getMeshRoleFromMetadata(
    metadata: Record<string, unknown> | undefined,
    fallback: RuntimeAgentRole = "worker",
  ): RuntimeAgentRole {
    return asStringValue(metadata?.role) === "broker" ? "broker" : fallback;
  }

  function buildSkinMetadata(
    metadata: Record<string, unknown> | undefined,
    personality: string,
    statusVocabulary?: PinetSkinStatusVocabulary,
  ): Record<string, unknown> {
    const baseMetadata = { ...(metadata ?? {}) };
    delete baseMetadata.skinStatusVocabulary;
    return {
      ...baseMetadata,
      ...(deps.getActiveSkinTheme() ? { skinTheme: deps.getActiveSkinTheme() } : {}),
      personality,
      ...(statusVocabulary ? { skinStatusVocabulary: statusVocabulary } : {}),
    };
  }

  function getIdentityGuidelines(): [string, string, string] {
    return buildIdentityReplyGuidelines(deps.getAgentEmoji(), deps.getAgentName(), selfLocation);
  }

  function applyRegistrationIdentity(registration: {
    name: string;
    emoji: string;
    metadata?: Record<string, unknown> | null;
  }): void {
    deps.setActiveSkinTheme(asStringValue(registration.metadata?.skinTheme) ?? null);
    applyLocalAgentIdentity(
      registration.name,
      registration.emoji,
      asStringValue(registration.metadata?.personality) ?? null,
    );
  }

  return {
    isUserAllowed,
    maybeWarnSlackUserAccess,
    maybeWarnSlackGuardrailPosture,
    getStableIdForRole,
    getIdentitySeedForRole,
    getSkinSeed,
    rememberAgentAlias,
    resolveSkinAssignment,
    applyLocalAgentIdentity,
    refreshSettings,
    snapshotReloadableRuntime,
    restoreReloadableRuntime,
    detectProjectTools,
    getAgentMetadata,
    asStringValue,
    getMeshRoleFromMetadata,
    buildSkinMetadata,
    getIdentityGuidelines,
    applyRegistrationIdentity,
  };
}
