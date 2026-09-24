import { exportPKCS8, generateKeyPair } from "jose";
import { describe, expect, it, vi } from "vitest";

import { GitHubAppAuthenticationError, mintCopilotInstallationToken } from "./github-app-auth.js";

async function privateKeyPem(): Promise<string> {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  return exportPKCS8(privateKey);
}

describe("mintCopilotInstallationToken", () => {
  it("requests a repository-scoped ghs token with copilot_requests write", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        repository_ids: [123456],
        permissions: { copilot_requests: "write" },
      });
      return new Response(
        JSON.stringify({
          token: "ghs_test_installation_token",
          expires_at: "2026-09-24T13:00:00.000Z",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    });

    const token = await mintCopilotInstallationToken(
      {
        appId: 123,
        installationId: 456,
        privateKey: await privateKeyPem(),
        repositoryId: 123456,
      },
      fetchMock as typeof fetch,
      new Date("2026-09-24T12:00:00.000Z"),
    );

    expect(token.token).toBe("ghs_test_installation_token");
    expect(token.expiresAt.toISOString()).toBe("2026-09-24T13:00:00.000Z");
  });

  it("surfaces actionable GitHub authentication failures", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "Resource not accessible by integration" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
    );

    await expect(
      mintCopilotInstallationToken(
        {
          appId: 123,
          installationId: 456,
          privateKey: await privateKeyPem(),
          repositoryId: 123456,
        },
        fetchMock as typeof fetch,
      ),
    ).rejects.toEqual(
      new GitHubAppAuthenticationError(
        "Unable to mint a Copilot installation token: Resource not accessible by integration",
        403,
      ),
    );
  });
});
