import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import type { CommanderStreamEvent, CopilotHealth } from "../shared/types.js";
import { createApp, type CommanderService } from "./app.js";
import { createTestContext } from "./test/test-database.js";

function createFakeCommander(overrides: Partial<CommanderService> = {}): CommanderService {
  return {
    getHealth: (): CopilotHealth => ({
      status: "unconfigured",
      message: "GitHub App authentication is not configured.",
      checkedAt: "2026-09-24T12:00:00.000Z",
    }),
    runMessage: async (_sessionId, _incidentId, _prompt, publish) => {
      publish({ type: "assistant_delta", delta: "Incident brief" });
      publish({ type: "done" });
    },
    resolveApproval: () => true,
    resetSessions: async () => undefined,
    ...overrides,
  };
}

describe("HTTP API", () => {
  it("returns incident details and a non-sensitive Copilot health state", async () => {
    const { database, incidentService } = createTestContext();
    const app = createApp({
      database,
      incidentService,
      copilotManager: createFakeCommander(),
    });

    const incidentResponse = await request(app).get("/api/incidents/INC-1042");
    const healthResponse = await request(app).get("/api/health/copilot");

    expect(incidentResponse.status).toBe(200);
    expect(incidentResponse.body.incident.title).toContain("Checkout failures");
    expect(healthResponse.body).toEqual({
      status: "unconfigured",
      message: "GitHub App authentication is not configured.",
      checkedAt: "2026-09-24T12:00:00.000Z",
    });
    expect(JSON.stringify(healthResponse.body)).not.toContain("token");
    database.close();
  });

  it("streams assistant and tool events as server-sent events", async () => {
    const { database, incidentService } = createTestContext();
    const events: CommanderStreamEvent[] = [
      {
        type: "tool_started",
        toolCallId: "call-1",
        toolName: "get_incident",
        label: "Reading incident record · started",
      },
      { type: "assistant_delta", delta: "The outage is correlated with v4.18.0." },
      { type: "done" },
    ];
    const app = createApp({
      database,
      incidentService,
      copilotManager: createFakeCommander({
        runMessage: async (_sessionId, _incidentId, _prompt, publish) => {
          events.forEach(publish);
        },
      }),
    });

    const response = await request(app).post("/api/copilot/sessions/test-session/messages").send({
      incidentId: "INC-1042",
      prompt: "Brief me",
    });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.text).toContain('"type":"tool_started"');
    expect(response.text).toContain('"type":"assistant_delta"');
    database.close();
  });

  it("requires explicit reset confirmation and restores canonical state", async () => {
    const { database, incidentService } = createTestContext();
    incidentService.assignIncident("INC-1042", "Maya Patel", {
      sessionId: "api-session",
    });
    const resetSessions = vi.fn(async () => undefined);
    const app = createApp({
      database,
      incidentService,
      copilotManager: createFakeCommander({ resetSessions }),
    });

    expect((await request(app).post("/api/demo/reset").send({ confirmation: "no" })).status).toBe(
      400,
    );
    const response = await request(app).post("/api/demo/reset").send({ confirmation: "RESET" });

    expect(response.status).toBe(200);
    expect(resetSessions).toHaveBeenCalledOnce();
    expect(incidentService.getIncident("INC-1042").assignee).toBeNull();
    database.close();
  });
});
