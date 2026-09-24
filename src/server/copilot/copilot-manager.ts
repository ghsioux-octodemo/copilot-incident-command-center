import fs from "node:fs";

import {
  CopilotClient,
  RuntimeConnection,
  type CopilotSession,
  type ResumeSessionConfig,
  type ToolExecutionStartEvent,
} from "@github/copilot-sdk";

import type { CommanderStreamEvent, CopilotHealth } from "../../shared/types.js";
import type { AppConfig } from "../config.js";
import type { IncidentService } from "../domain/incident-service.js";
import type { ApprovalBroker } from "./approval-broker.js";
import { mintCopilotInstallationToken } from "./github-app-auth.js";
import { createIncidentTools, createPermissionHandler, incidentToolNames } from "./tools.js";

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export class CopilotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopilotUnavailableError";
  }
}

interface ManagedClient {
  client: CopilotClient;
  tokenExpiresAt: Date;
}

interface ManagedSession {
  session: CopilotSession;
  unsubscribe: () => void;
  toolNamesByCallId: Map<string, string>;
}

export class CopilotManager {
  private managedClient: ManagedClient | undefined;
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly knownRuntimeSessionIds = new Set<string>();
  private health: CopilotHealth;

  constructor(
    private readonly config: AppConfig,
    private readonly incidentService: IncidentService,
    private readonly approvalBroker: ApprovalBroker,
  ) {
    this.health = initialHealth(config);
  }

  getHealth(): CopilotHealth {
    return this.health;
  }

  async warmup(): Promise<void> {
    if (!this.config.githubApp || this.config.githubAppConfigurationError) {
      return;
    }
    try {
      await this.ensureClient();
    } catch {
      // getHealth exposes the actionable error without making server startup fail.
    }
  }

  async runMessage(
    browserSessionId: string,
    incidentId: string,
    prompt: string,
    publish: (event: CommanderStreamEvent) => void,
  ): Promise<void> {
    this.incidentService.createCopilotSession(browserSessionId, incidentId);
    const detachPublisher = this.approvalBroker.attachPublisher(browserSessionId, publish);
    publish({ type: "session", sessionId: browserSessionId });

    try {
      const managedSession = await this.getOrCreateSession(browserSessionId, publish);
      const contextualPrompt = [
        `The user is viewing incident ${incidentId}.`,
        "Use the incident tools for authoritative context. Never invent incident state.",
        prompt,
      ].join("\n\n");
      const result = await managedSession.session.sendAndWait(
        { prompt: contextualPrompt },
        2 * 60 * 1000,
      );
      if (result?.data.content) {
        publish({ type: "assistant_complete", content: result.data.content });
      }
      publish({ type: "done" });
    } catch (error) {
      publish({
        type: "error",
        message: errorMessage(error),
        code: error instanceof CopilotUnavailableError ? "COPILOT_UNAVAILABLE" : "COPILOT_ERROR",
      });
      publish({ type: "done" });
    } finally {
      detachPublisher();
    }
  }

  resolveApproval(browserSessionId: string, approvalId: string, approved: boolean): boolean {
    return Boolean(this.approvalBroker.resolve(browserSessionId, approvalId, approved));
  }

  async stop(): Promise<void> {
    for (const sessionId of this.sessions.keys()) {
      this.approvalBroker.cancelSession(sessionId);
    }
    await this.disposeSessions();
    if (this.managedClient) {
      await this.managedClient.client.stop();
      this.managedClient = undefined;
    }
  }

  async resetSessions(): Promise<void> {
    const sessionIds = [...this.knownRuntimeSessionIds];
    for (const sessionId of sessionIds) {
      this.approvalBroker.cancelSession(sessionId);
    }
    await this.disposeSessions();
    if (this.managedClient) {
      await Promise.all(
        sessionIds.map(async (sessionId) => {
          try {
            await this.managedClient!.client.deleteSession(sessionId);
          } catch (error) {
            console.warn(`Unable to delete Copilot session ${sessionId}: ${errorMessage(error)}`);
          }
        }),
      );
    }
    this.knownRuntimeSessionIds.clear();
  }

  private async getOrCreateSession(
    browserSessionId: string,
    publish: (event: CommanderStreamEvent) => void,
  ): Promise<ManagedSession> {
    await this.ensureClient();
    const existing = this.sessions.get(browserSessionId);
    if (existing) {
      existing.unsubscribe();
      existing.unsubscribe = this.subscribe(existing, publish);
      return existing;
    }

    const context = {
      browserSessionId,
      incidentService: this.incidentService,
      approvalBroker: this.approvalBroker,
      publish,
    };
    const sessionConfig = {
      model: this.config.copilotModel,
      tools: createIncidentTools(context),
      availableTools: Array.from(incidentToolNames),
      customAgents: [
        {
          name: "incident-commander",
          displayName: "Incident Commander",
          description: "Analyzes incidents and coordinates approved response actions.",
          tools: [...incidentToolNames],
          prompt: INCIDENT_COMMANDER_PROMPT,
        },
      ],
      agent: "incident-commander",
      streaming: true,
      enableSessionStore: false,
      skipCustomInstructions: true,
      customAgentsLocalOnly: true,
      onPermissionRequest: createPermissionHandler(context),
    } satisfies ResumeSessionConfig;

    const client = this.managedClient!.client;
    const session = this.knownRuntimeSessionIds.has(browserSessionId)
      ? await client.resumeSession(browserSessionId, sessionConfig)
      : await client.createSession({ sessionId: browserSessionId, ...sessionConfig });
    this.knownRuntimeSessionIds.add(browserSessionId);

    const managed: ManagedSession = {
      session,
      unsubscribe: () => undefined,
      toolNamesByCallId: new Map(),
    };
    managed.unsubscribe = this.subscribe(managed, publish);
    this.sessions.set(browserSessionId, managed);
    return managed;
  }

  private subscribe(
    managed: ManagedSession,
    publish: (event: CommanderStreamEvent) => void,
  ): () => void {
    return managed.session.on((event) => {
      if (event.agentId) {
        return;
      }
      switch (event.type) {
        case "assistant.message_delta":
          publish({ type: "assistant_delta", delta: event.data.deltaContent });
          break;
        case "tool.execution_start": {
          const startEvent = event as ToolExecutionStartEvent;
          managed.toolNamesByCallId.set(startEvent.data.toolCallId, startEvent.data.toolName);
          publish({
            type: "tool_started",
            toolCallId: startEvent.data.toolCallId,
            toolName: startEvent.data.toolName,
            arguments: startEvent.data.arguments,
            label: toolActivityLabel(startEvent.data.toolName, "started"),
          });
          break;
        }
        case "tool.execution_complete": {
          const toolName =
            managed.toolNamesByCallId.get(event.data.toolCallId) ??
            event.data.toolDescription?.name ??
            "tool";
          publish({
            type: "tool_completed",
            toolCallId: event.data.toolCallId,
            toolName,
            success: event.data.success,
            label: toolActivityLabel(toolName, event.data.success ? "completed" : "failed"),
          });
          break;
        }
      }
    });
  }

  private async ensureClient(): Promise<void> {
    if (this.config.githubAppConfigurationError) {
      this.setHealth("error", this.config.githubAppConfigurationError);
      throw new CopilotUnavailableError(this.config.githubAppConfigurationError);
    }
    if (!this.config.githubApp) {
      const message =
        "Copilot is not configured. Add the GitHub App values from .env.example and restart.";
      this.setHealth("unconfigured", message);
      throw new CopilotUnavailableError(message);
    }

    if (
      this.managedClient &&
      this.managedClient.tokenExpiresAt.getTime() - Date.now() > TOKEN_REFRESH_BUFFER_MS
    ) {
      return;
    }

    try {
      await this.rotateClient();
      this.setHealth(
        "healthy",
        `GitHub App installation authentication is healthy. Runtime token expires at ${this.managedClient!.tokenExpiresAt.toISOString()}.`,
      );
    } catch (error) {
      const message = `Copilot authentication/runtime error: ${errorMessage(error)}`;
      this.setHealth("error", message);
      throw new CopilotUnavailableError(message);
    }
  }

  private async rotateClient(): Promise<void> {
    await this.disposeSessions();
    if (this.managedClient) {
      await this.managedClient.client.stop();
      this.managedClient = undefined;
    }

    const installationToken = await mintCopilotInstallationToken(this.config.githubApp!);
    fs.mkdirSync(this.config.copilotHomePath, { recursive: true });
    const runtimeEnvironment = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => Boolean(entry[1])),
    );
    delete runtimeEnvironment.GH_TOKEN;
    delete runtimeEnvironment.GITHUB_TOKEN;
    delete runtimeEnvironment.GITHUB_COPILOT_API_TOKEN;
    delete runtimeEnvironment.COPILOT_API_URL;
    runtimeEnvironment.COPILOT_GITHUB_TOKEN = installationToken.token;

    const client = new CopilotClient({
      clientInfo: {
        applicationName: "copilot-incident-command-center",
        applicationVersion: "1.0.0",
      },
      mode: "empty",
      baseDirectory: this.config.copilotHomePath,
      useLoggedInUser: false,
      connection: RuntimeConnection.forStdio({ env: runtimeEnvironment }),
      logLevel: "error",
    });
    await client.start();
    await client.ping("incident-command-center-health-check");
    this.managedClient = {
      client,
      tokenExpiresAt: installationToken.expiresAt,
    };
  }

  private async disposeSessions(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      sessions.map(async ({ session, unsubscribe }) => {
        unsubscribe();
        await session.disconnect();
      }),
    );
  }

  private setHealth(status: CopilotHealth["status"], message: string): void {
    this.health = {
      status,
      message,
      checkedAt: new Date().toISOString(),
    };
  }
}

const INCIDENT_COMMANDER_PROMPT = `You are Incident Commander inside a business incident-management application.
Use only the provided incident tools. Begin analysis by reading the incident, timeline, service health, and related incidents when useful.
Be concise, decisive, and evidence-based. Clearly separate confirmed facts from the most likely cause.
For a briefing, summarize customer impact, current state, evidence, likely cause, and immediate recommended actions.
When the user explicitly asks you to take response actions, use the write tools with exact arguments. The host will require browser approval for every mutation. Never claim a write succeeded until the tool result confirms it.
Do not discuss source code, the local filesystem, or unavailable systems.`;

function initialHealth(config: AppConfig): CopilotHealth {
  if (config.githubAppConfigurationError) {
    return {
      status: "error",
      message: config.githubAppConfigurationError,
      checkedAt: new Date().toISOString(),
    };
  }
  if (!config.githubApp) {
    return {
      status: "unconfigured",
      message: "GitHub App authentication is not configured.",
      checkedAt: new Date().toISOString(),
    };
  }
  return {
    status: "configured",
    message: "GitHub App authentication is configured; runtime health has not been verified yet.",
    checkedAt: new Date().toISOString(),
  };
}

function toolActivityLabel(toolName: string, phase: "started" | "completed" | "failed"): string {
  const labels: Record<string, string> = {
    get_incident: "Reading incident record",
    get_incident_timeline: "Reading incident timeline",
    get_service_health: "Checking service health",
    list_related_incidents: "Finding related incidents",
    assign_incident: "Assigning incident",
    update_incident_status: "Updating incident status",
    add_timeline_note: "Adding timeline note",
  };
  return `${labels[toolName] ?? toolName} · ${phase}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
