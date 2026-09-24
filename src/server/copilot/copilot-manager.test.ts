import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig, CopilotAuthConfig } from "../config.js";
import type { IncidentService } from "../domain/incident-service.js";
import type { ApprovalBroker } from "./approval-broker.js";

const sdkMock = vi.hoisted(() => ({
  clientOptions: [] as Array<Record<string, unknown>>,
  authStatus: {
    isAuthenticated: true,
    authType: "token",
    statusMessage: "Authenticated",
  } as { isAuthenticated: boolean; authType?: string; statusMessage?: string },
  models: [{ id: "gpt-5" }],
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  getAuthStatus: vi.fn(async () => sdkMock.authStatus),
  listModels: vi.fn(async () => sdkMock.models),
}));

const mintMock = vi.hoisted(() =>
  vi.fn(async () => ({
    token: "ghs_test_installation_token",
    expiresAt: new Date("2026-09-24T15:00:00.000Z"),
  })),
);

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: class {
    constructor(options: Record<string, unknown>) {
      sdkMock.clientOptions.push(options);
    }

    start = sdkMock.start;
    stop = sdkMock.stop;
    getAuthStatus = sdkMock.getAuthStatus;
    listModels = sdkMock.listModels;
  },
  RuntimeConnection: {
    forStdio: vi.fn(() => ({ kind: "stdio" })),
  },
}));

vi.mock("./github-app-auth.js", () => ({
  mintCopilotInstallationToken: mintMock,
}));

import { CopilotManager } from "./copilot-manager.js";

describe("CopilotManager authentication", () => {
  beforeEach(() => {
    sdkMock.clientOptions.length = 0;
    sdkMock.authStatus = {
      isAuthenticated: true,
      authType: "token",
      statusMessage: "Authenticated",
    };
    sdkMock.models = [{ id: "gpt-5" }];
    sdkMock.start.mockClear();
    sdkMock.stop.mockClear();
    sdkMock.getAuthStatus.mockClear();
    sdkMock.listModels.mockClear();
    mintMock.mockClear();
  });

  it("passes a GitHub App installation token through the documented runtime environment", async () => {
    const manager = createManager({
      mode: "github-app",
      appId: 123,
      installationId: 456,
      privateKey: "private-key",
      repositoryId: 789,
    });

    await manager.warmup();

    expect(mintMock).toHaveBeenCalledOnce();
    expect(sdkMock.clientOptions[0]).toMatchObject({
      useLoggedInUser: false,
      env: expect.objectContaining({
        COPILOT_GITHUB_TOKEN: "ghs_test_installation_token",
      }),
    });
    expect(sdkMock.clientOptions[0]).not.toHaveProperty("gitHubToken");
    expect(manager.getHealth()).toMatchObject({
      status: "healthy",
      message: expect.stringContaining("GitHub App installation authentication is healthy"),
    });
  });

  it("passes a user token through the SDK user-token option", async () => {
    const manager = createManager({
      mode: "user-token",
      token: "github_pat_test",
    });

    await manager.warmup();

    expect(mintMock).not.toHaveBeenCalled();
    expect(sdkMock.clientOptions[0]).toMatchObject({
      gitHubToken: "github_pat_test",
      useLoggedInUser: false,
      env: expect.not.objectContaining({
        COPILOT_USER_TOKEN: expect.anything(),
      }),
    });
    expect(manager.getHealth()).toMatchObject({
      status: "healthy",
      message: "GitHub user-token authentication is healthy.",
    });
  });

  it("reports an actionable error when an installation token is minted but not authenticated", async () => {
    sdkMock.authStatus = {
      isAuthenticated: false,
      statusMessage: "Not authenticated",
    };
    const manager = createManager({
      mode: "github-app",
      appId: 123,
      installationId: 456,
      privateKey: "private-key",
      repositoryId: 789,
    });

    await manager.warmup();

    expect(manager.getHealth()).toMatchObject({
      status: "error",
      message: expect.stringContaining(
        "Confirm that the App ID and organization are enabled for Copilot SDK server-to-server authentication",
      ),
    });
    expect(sdkMock.stop).toHaveBeenCalledOnce();
  });

  it("reports when the configured model is unavailable", async () => {
    sdkMock.models = [{ id: "gpt-4.1" }];
    const manager = createManager({
      mode: "user-token",
      token: "github_pat_test",
    });

    await manager.warmup();

    expect(manager.getHealth()).toMatchObject({
      status: "error",
      message: expect.stringContaining('Configured model "gpt-5" is not available'),
    });
  });
});

function createManager(copilotAuth: CopilotAuthConfig): CopilotManager {
  const config: AppConfig = {
    port: 3001,
    databasePath: ":memory:",
    copilotModel: "gpt-5",
    copilotHomePath: "/tmp/copilot-manager-test",
    copilotAuth,
    copilotAuthConfigurationError: undefined,
  };
  return new CopilotManager(config, {} as IncidentService, {} as ApprovalBroker);
}
