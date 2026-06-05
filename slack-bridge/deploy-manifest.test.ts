import { describe, expect, it } from "vitest";
import {
  applyConfiguredSlashCommands,
  diffManifestScopes,
  formatScopeChangeSummary,
  getDeployConfigError,
  resolveDeployConfig,
} from "./deploy-manifest.js";

describe("resolveDeployConfig", () => {
  it("prefers settings over environment values", () => {
    expect(
      resolveDeployConfig(
        {
          appId: "ASETTINGS",
          appConfigToken: "xoxe-settings",
          appToken: "xapp-settings",
        },
        {
          SLACK_APP_ID: "AENV",
          SLACK_APP_CONFIG_TOKEN: "xoxe-env",
          SLACK_APP_TOKEN: "xapp-env",
        },
        "/repo",
      ),
    ).toEqual({
      manifestPath: "/repo/slack-bridge/manifest.yaml",
      appId: "ASETTINGS",
      appConfigToken: "xoxe-settings",
      appToken: "xapp-settings",
      settings: {
        appId: "ASETTINGS",
        appConfigToken: "xoxe-settings",
        appToken: "xapp-settings",
      },
    });
  });

  it("falls back to environment values", () => {
    expect(
      resolveDeployConfig({}, { SLACK_APP_ID: "AENV", SLACK_CONFIG_TOKEN: "xoxe-env" }, "/repo"),
    ).toEqual({
      manifestPath: "/repo/slack-bridge/manifest.yaml",
      appId: "AENV",
      appConfigToken: "xoxe-env",
      appToken: undefined,
      settings: {},
    });
  });
});

describe("getDeployConfigError", () => {
  it("mentions the xapp token when a config token is missing", () => {
    const error = getDeployConfigError({
      manifestPath: "manifest.yaml",
      appId: "A123",
      appToken: "xapp-123",
      settings: {},
    });

    expect(error).toContain("Missing Slack app configuration token");
    expect(error).toContain("xapp token");
  });
});

describe("applyConfiguredSlashCommands", () => {
  it("rewrites slash command names from settings and keeps commands scope", () => {
    const manifest = applyConfiguredSlashCommands(
      {
        features: { slash_commands: [{ command: "/pinet" }] },
        oauth_config: { scopes: { bot: ["chat:write"] } },
      },
      { slackCommandName: "Oathgate" },
    );

    expect(manifest.features).toEqual({
      slash_commands: [
        {
          command: "/oathgate",
          description: "Show the Pinet broker roster and current work",
          usage_hint: "agents list [all]",
          should_escape: false,
        },
      ],
    });
    expect((manifest.oauth_config as { scopes: { bot: string[] } }).scopes.bot).toEqual([
      "chat:write",
      "commands",
    ]);
  });
});

describe("diffManifestScopes", () => {
  it("reports added and removed bot/user scopes", () => {
    const changes = diffManifestScopes(
      {
        oauth_config: {
          scopes: {
            bot: ["chat:write", "channels:read"],
            user: ["search:read"],
          },
        },
      },
      {
        oauth_config: {
          scopes: {
            bot: ["chat:write", "channels:history", "groups:read"],
            user: ["users:read"],
          },
        },
      },
    );

    expect(changes).toEqual({
      addedBotScopes: ["channels:history", "groups:read"],
      removedBotScopes: ["channels:read"],
      addedUserScopes: ["users:read"],
      removedUserScopes: ["search:read"],
    });
  });
});

describe("formatScopeChangeSummary", () => {
  it("returns a no-change summary when nothing changed", () => {
    expect(
      formatScopeChangeSummary({
        addedBotScopes: [],
        removedBotScopes: [],
        addedUserScopes: [],
        removedUserScopes: [],
      }),
    ).toEqual(["No scope changes."]);
  });

  it("formats added and removed scope lines", () => {
    expect(
      formatScopeChangeSummary({
        addedBotScopes: ["chat:write"],
        removedBotScopes: ["channels:read"],
        addedUserScopes: [],
        removedUserScopes: ["search:read"],
      }),
    ).toEqual([
      "Bot scopes added: chat:write",
      "Bot scopes removed: channels:read",
      "User scopes removed: search:read",
    ]);
  });
});
