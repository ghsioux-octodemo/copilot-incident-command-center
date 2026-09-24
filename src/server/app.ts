import crypto from "node:crypto";
import path from "node:path";

import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";

import type { CommanderStreamEvent, CopilotHealth } from "../shared/types.js";
import { resetDatabase, type SqliteDatabase } from "./db/database.js";
import { IncidentNotFoundError, type IncidentService } from "./domain/incident-service.js";

const sessionSchema = z.object({
  incidentId: z.string().min(1),
});

const messageSchema = z.object({
  incidentId: z.string().min(1),
  prompt: z.string().trim().min(1).max(4000),
});

const approvalSchema = z.object({
  decision: z.enum(["approve", "deny"]),
});

const resetSchema = z.object({
  confirmation: z.literal("RESET"),
});

export interface CommanderService {
  getHealth(): CopilotHealth;
  runMessage(
    sessionId: string,
    incidentId: string,
    prompt: string,
    publish: (event: CommanderStreamEvent) => void,
  ): Promise<void>;
  resolveApproval(sessionId: string, approvalId: string, approved: boolean): boolean;
  resetSessions(): Promise<void>;
}

interface AppDependencies {
  database: SqliteDatabase;
  incidentService: IncidentService;
  copilotManager: CommanderService;
}

export function createApp({
  database,
  incidentService,
  copilotManager,
}: AppDependencies): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));

  app.get("/api/incidents", (_request, response) => {
    response.json({ incidents: incidentService.listIncidents() });
  });

  app.get("/api/incidents/:incidentId", (request, response) => {
    response.json({ incident: incidentService.getIncident(request.params.incidentId) });
  });

  app.get("/api/audit", (_request, response) => {
    response.json({ auditEvents: incidentService.getAuditEvents() });
  });

  app.get("/api/health/copilot", (_request, response) => {
    response.json(copilotManager.getHealth());
  });

  app.post("/api/copilot/sessions", (request, response) => {
    const { incidentId } = sessionSchema.parse(request.body);
    incidentService.getIncident(incidentId);
    response.status(201).json({ sessionId: crypto.randomUUID() });
  });

  app.post("/api/copilot/sessions/:sessionId/messages", async (request, response, next) => {
    try {
      const { incidentId, prompt } = messageSchema.parse(request.body);
      incidentService.getIncident(incidentId);
      configureEventStream(response);
      await copilotManager.runMessage(request.params.sessionId, incidentId, prompt, (event) =>
        writeStreamEvent(response, event),
      );
      response.end();
    } catch (error) {
      if (response.headersSent) {
        writeStreamEvent(response, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        writeStreamEvent(response, { type: "done" });
        response.end();
        return;
      }
      next(error);
    }
  });

  app.post("/api/copilot/sessions/:sessionId/approvals/:approvalId", (request, response) => {
    const { decision } = approvalSchema.parse(request.body);
    const resolved = copilotManager.resolveApproval(
      request.params.sessionId,
      request.params.approvalId,
      decision === "approve",
    );
    if (!resolved) {
      response.status(404).json({
        error: "Approval request not found, already resolved, or associated with another session.",
      });
      return;
    }
    response.json({ decision });
  });

  app.post("/api/demo/reset", async (request, response) => {
    resetSchema.parse(request.body);
    await copilotManager.resetSessions();
    resetDatabase(database);
    response.json({
      resetAt: new Date().toISOString(),
      incidents: incidentService.listIncidents(),
    });
  });

  const clientDirectory = path.resolve(process.cwd(), "dist/client");
  app.use(express.static(clientDirectory));
  app.get("*splat", (request, response, next) => {
    if (request.path.startsWith("/api/")) {
      next();
      return;
    }
    response.sendFile(path.join(clientDirectory, "index.html"));
  });

  app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    void next;
    if (error instanceof IncidentNotFoundError) {
      response.status(404).json({ error: error.message });
      return;
    }
    if (error instanceof z.ZodError) {
      response.status(400).json({
        error: "Invalid request.",
        details: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }

    console.error(error);
    response.status(500).json({
      error: "The server could not complete the request.",
    });
  });

  return app;
}

function configureEventStream(response: Response): void {
  response.status(200);
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
}

function writeStreamEvent(response: Response, event: CommanderStreamEvent): void {
  if (!response.writableEnded) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}
