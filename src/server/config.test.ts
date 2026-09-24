import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("defaults to an unconfigured GitHub App mode", () => {
    const config = loadConfig({
      GITHUB_APP_ID: "",
      GITHUB_APP_INSTALLATION_ID: "",
      GITHUB_APP_PRIVATE_KEY: "",
      GITHUB_REPOSITORY_ID: "",
    });

    expect(config.copilotAuth).toBeUndefined();
    expect(config.copilotAuthConfigurationError).toBeUndefined();
  });

  it("loads complete GitHub App authentication and normalizes escaped newlines", () => {
    const config = loadConfig({
      COPILOT_AUTH_MODE: "github-app",
      GITHUB_APP_ID: "123",
      GITHUB_APP_INSTALLATION_ID: "456",
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----",
      GITHUB_REPOSITORY_ID: "789",
    });

    expect(config.copilotAuth).toEqual({
      mode: "github-app",
      appId: 123,
      installationId: 456,
      privateKey: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
      repositoryId: 789,
    });
    expect(config.copilotAuthConfigurationError).toBeUndefined();
  });

  it("reports partial GitHub App configuration", () => {
    const config = loadConfig({
      COPILOT_AUTH_MODE: "github-app",
      GITHUB_APP_ID: "123",
    });

    expect(config.copilotAuth).toBeUndefined();
    expect(config.copilotAuthConfigurationError).toContain("partially configured");
  });

  it("loads a fine-grained user token without requiring GitHub App values", () => {
    const config = loadConfig({
      COPILOT_AUTH_MODE: "user-token",
      COPILOT_USER_TOKEN: "github_pat_test",
      GITHUB_APP_ID: "",
      GITHUB_APP_INSTALLATION_ID: "",
      GITHUB_APP_PRIVATE_KEY: "",
      GITHUB_REPOSITORY_ID: "",
    });

    expect(config.copilotAuth).toEqual({
      mode: "user-token",
      token: "github_pat_test",
    });
    expect(config.copilotAuthConfigurationError).toBeUndefined();
  });

  it("rejects missing and classic user tokens with actionable errors", () => {
    const missing = loadConfig({
      COPILOT_AUTH_MODE: "user-token",
      COPILOT_USER_TOKEN: "",
    });
    const classic = loadConfig({
      COPILOT_AUTH_MODE: "user-token",
      COPILOT_USER_TOKEN: "ghp_test",
    });

    expect(missing.copilotAuthConfigurationError).toContain("requires COPILOT_USER_TOKEN");
    expect(classic.copilotAuthConfigurationError).toContain(
      "Classic ghp_ tokens are not supported",
    );
  });
});
