import crypto from "node:crypto";

import { SignJWT } from "jose";

export interface GitHubAppCredentials {
  appId: number;
  installationId: number;
  privateKey: string;
  repositoryId: number;
}

export interface InstallationToken {
  token: string;
  expiresAt: Date;
}

interface InstallationTokenResponse {
  token?: string;
  expires_at?: string;
  message?: string;
  documentation_url?: string;
}

export class GitHubAppAuthenticationError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubAppAuthenticationError";
  }
}

export async function mintCopilotInstallationToken(
  credentials: GitHubAppCredentials,
  fetchImplementation: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<InstallationToken> {
  const jwt = await createAppJwt(credentials, now);
  const response = await fetchImplementation(
    `https://api.github.com/app/installations/${credentials.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        repository_ids: [credentials.repositoryId],
        permissions: {
          copilot_requests: "write",
        },
      }),
    },
  );

  const payload = (await response.json()) as InstallationTokenResponse;
  if (!response.ok || !payload.token || !payload.expires_at) {
    const detail = payload.message ?? `GitHub returned HTTP ${response.status}.`;
    throw new GitHubAppAuthenticationError(
      `Unable to mint a Copilot installation token: ${detail}`,
      response.status,
    );
  }

  if (!payload.token.startsWith("ghs_")) {
    throw new GitHubAppAuthenticationError(
      "GitHub returned an unexpected token type; an installation token beginning with ghs_ is required.",
    );
  }

  return {
    token: payload.token,
    expiresAt: new Date(payload.expires_at),
  };
}

async function createAppJwt(credentials: GitHubAppCredentials, now: Date): Promise<string> {
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey(credentials.privateKey);
  } catch (error) {
    throw new GitHubAppAuthenticationError(
      `GITHUB_APP_PRIVATE_KEY is not a valid RSA private key: ${errorMessage(error)}`,
    );
  }

  const issuedAt = Math.floor(now.getTime() / 1000) - 30;
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(issuedAt)
    .setIssuer(String(credentials.appId))
    .setExpirationTime(issuedAt + 9 * 60)
    .sign(key);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
