import path from "node:path";

import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const optionalPositiveInteger = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().regex(/^\d+$/).transform(Number).optional(),
);
const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);

const environmentSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_PATH: z.string().trim().default("./data/incidents.db"),
  COPILOT_AUTH_MODE: z.enum(["github-app", "user-token"]).default("github-app"),
  COPILOT_USER_TOKEN: optionalNonEmptyString,
  GITHUB_APP_ID: optionalPositiveInteger,
  GITHUB_APP_INSTALLATION_ID: optionalPositiveInteger,
  GITHUB_APP_PRIVATE_KEY: optionalNonEmptyString,
  GITHUB_REPOSITORY_ID: optionalPositiveInteger,
  COPILOT_MODEL: z.string().trim().default("gpt-5"),
});

export type CopilotAuthConfig =
  | {
      mode: "github-app";
      appId: number;
      installationId: number;
      privateKey: string;
      repositoryId: number;
    }
  | {
      mode: "user-token";
      token: string;
    };

export interface AppConfig {
  port: number;
  databasePath: string;
  copilotModel: string;
  copilotHomePath: string;
  copilotAuth: CopilotAuthConfig | undefined;
  copilotAuthConfigurationError: string | undefined;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);
  const { copilotAuth, configurationError } =
    parsed.COPILOT_AUTH_MODE === "user-token"
      ? loadUserTokenAuth(parsed.COPILOT_USER_TOKEN)
      : loadGitHubAppAuth({
          appId: parsed.GITHUB_APP_ID,
          installationId: parsed.GITHUB_APP_INSTALLATION_ID,
          privateKey: parsed.GITHUB_APP_PRIVATE_KEY,
          repositoryId: parsed.GITHUB_REPOSITORY_ID,
        });

  return {
    port: parsed.PORT,
    databasePath: parsed.DATABASE_PATH,
    copilotModel: parsed.COPILOT_MODEL,
    copilotHomePath: path.resolve("./data/copilot-home"),
    copilotAuth,
    copilotAuthConfigurationError: configurationError,
  };
}

function loadGitHubAppAuth(values: {
  appId: number | undefined;
  installationId: number | undefined;
  privateKey: string | undefined;
  repositoryId: number | undefined;
}): {
  copilotAuth: CopilotAuthConfig | undefined;
  configurationError: string | undefined;
} {
  const configuredCount = Object.values(values).filter((value) => value !== undefined).length;
  if (configuredCount === 0) {
    return { copilotAuth: undefined, configurationError: undefined };
  }
  if (configuredCount < Object.keys(values).length) {
    return {
      copilotAuth: undefined,
      configurationError:
        "GitHub App authentication is partially configured. Set GITHUB_APP_ID, " +
        "GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_REPOSITORY_ID.",
    };
  }

  return {
    copilotAuth: {
      mode: "github-app",
      appId: values.appId!,
      installationId: values.installationId!,
      privateKey: normalizePrivateKey(values.privateKey!),
      repositoryId: values.repositoryId!,
    },
    configurationError: undefined,
  };
}

function loadUserTokenAuth(token: string | undefined): {
  copilotAuth: CopilotAuthConfig | undefined;
  configurationError: string | undefined;
} {
  if (!token) {
    return {
      copilotAuth: undefined,
      configurationError:
        "User-token authentication requires COPILOT_USER_TOKEN to be set to a supported GitHub user token.",
    };
  }
  if (!/^(github_pat_|gho_|ghu_)/.test(token)) {
    return {
      copilotAuth: undefined,
      configurationError:
        "COPILOT_USER_TOKEN must be a fine-grained personal access token (github_pat_) " +
        "or a GitHub OAuth user token (gho_ or ghu_). Classic ghp_ tokens are not supported.",
    };
  }
  return {
    copilotAuth: { mode: "user-token", token },
    configurationError: undefined,
  };
}

function normalizePrivateKey(value: string): string {
  return value.trim().replaceAll("\\n", "\n");
}
