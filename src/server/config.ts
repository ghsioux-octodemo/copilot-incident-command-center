import path from "node:path";

import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const optionalPositiveInteger = z.string().trim().regex(/^\d+$/).transform(Number).optional();

const environmentSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_PATH: z.string().trim().default("./data/incidents.db"),
  GITHUB_APP_ID: optionalPositiveInteger,
  GITHUB_APP_INSTALLATION_ID: optionalPositiveInteger,
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_REPOSITORY_ID: optionalPositiveInteger,
  COPILOT_MODEL: z.string().trim().default("gpt-5"),
});

export interface AppConfig {
  port: number;
  databasePath: string;
  copilotModel: string;
  copilotHomePath: string;
  githubApp:
    | {
        appId: number;
        installationId: number;
        privateKey: string;
        repositoryId: number;
      }
    | undefined;
  githubAppConfigurationError: string | undefined;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(environment);
  const githubValues = [
    parsed.GITHUB_APP_ID,
    parsed.GITHUB_APP_INSTALLATION_ID,
    parsed.GITHUB_APP_PRIVATE_KEY,
    parsed.GITHUB_REPOSITORY_ID,
  ];
  const configuredCount = githubValues.filter(
    (value) => value !== undefined && value !== "",
  ).length;

  let githubApp: AppConfig["githubApp"];
  let githubAppConfigurationError: string | undefined;

  if (configuredCount > 0 && configuredCount < githubValues.length) {
    githubAppConfigurationError =
      "GitHub App authentication is partially configured. Set GITHUB_APP_ID, " +
      "GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_REPOSITORY_ID.";
  } else if (configuredCount === githubValues.length) {
    githubApp = {
      appId: parsed.GITHUB_APP_ID!,
      installationId: parsed.GITHUB_APP_INSTALLATION_ID!,
      privateKey: normalizePrivateKey(parsed.GITHUB_APP_PRIVATE_KEY!),
      repositoryId: parsed.GITHUB_REPOSITORY_ID!,
    };
  }

  return {
    port: parsed.PORT,
    databasePath: parsed.DATABASE_PATH,
    copilotModel: parsed.COPILOT_MODEL,
    copilotHomePath: path.resolve("./data/copilot-home"),
    githubApp,
    githubAppConfigurationError,
  };
}

function normalizePrivateKey(value: string): string {
  return value.trim().replaceAll("\\n", "\n");
}
