import type { PermissionRequest, Tool } from "@github/copilot-sdk";
import { describe, expect, it, vi } from "vitest";

import type { CommanderStreamEvent } from "../../shared/types.js";
import { createTestContext } from "../test/test-database.js";
import { ApprovalBroker } from "./approval-broker.js";
import { createIncidentTools, createPermissionHandler, incidentToolNames } from "./tools.js";

describe("incident Copilot tools", () => {
  it("exposes only the domain tools and marks reads as permission-free", async () => {
    const { database, incidentService } = createTestContext();
    const tools = createIncidentTools({
      browserSessionId: "tool-session",
      incidentService,
      approvalBroker: new ApprovalBroker(),
      publish: vi.fn(),
    });

    expect(tools.map((tool) => tool.name)).toEqual(incidentToolNames);
    expect(tools.slice(0, 4).every((tool) => tool.skipPermission)).toBe(true);
    expect(tools.slice(4).every((tool) => !tool.skipPermission)).toBe(true);

    const getIncidentTool = tools.find((tool) => tool.name === "get_incident") as Tool<{
      incidentId: string;
    }>;
    const result = await getIncidentTool.handler?.(
      { incidentId: "INC-1042" },
      {
        sessionId: "runtime-session",
        toolCallId: "call-1",
        toolName: "get_incident",
        arguments: { incidentId: "INC-1042" },
      },
    );
    expect(result).toMatchObject({ id: "INC-1042", severity: "P1" });
    database.close();
  });

  it("requires browser approval before the runtime can invoke a write tool", async () => {
    const { database, incidentService } = createTestContext();
    const broker = new ApprovalBroker();
    let approvalId = "";
    broker.attachPublisher("browser-session", (event: CommanderStreamEvent) => {
      if (event.type === "approval_required") {
        approvalId = event.approval.id;
      }
    });
    const handler = createPermissionHandler({
      browserSessionId: "browser-session",
      incidentService,
      approvalBroker: broker,
      publish: vi.fn(),
    });
    const request: PermissionRequest = {
      kind: "custom-tool",
      toolName: "update_incident_status",
      toolDescription: "Change status",
      toolCallId: "call-2",
      args: { incidentId: "INC-1042", status: "Investigating" },
    };

    const decisionPromise = handler(request, { sessionId: "runtime-session" });
    expect(approvalId).not.toBe("");
    broker.resolve("browser-session", approvalId, true);

    await expect(decisionPromise).resolves.toEqual({ kind: "approved" });
    expect(incidentService.getIncident("INC-1042").status).toBe("Triggered");
    database.close();
  });

  it("records a denial and returns a rejected permission decision", async () => {
    const { database, incidentService } = createTestContext();
    const broker = new ApprovalBroker();
    let approvalId = "";
    broker.attachPublisher("browser-session", (event) => {
      if (event.type === "approval_required") {
        approvalId = event.approval.id;
      }
    });
    const handler = createPermissionHandler({
      browserSessionId: "browser-session",
      incidentService,
      approvalBroker: broker,
      publish: vi.fn(),
    });

    const decisionPromise = handler(
      {
        kind: "custom-tool",
        toolName: "assign_incident",
        toolDescription: "Assign incident",
        args: { incidentId: "INC-1042", assignee: "Maya Patel" },
      },
      { sessionId: "runtime-session" },
    );
    broker.resolve("browser-session", approvalId, false);

    await expect(decisionPromise).resolves.toMatchObject({ kind: "reject" });
    expect(incidentService.getIncident("INC-1042").assignee).toBeNull();
    expect(incidentService.getIncident("INC-1042").auditEvents[0]).toMatchObject({
      action: "assign_incident",
      outcome: "denied",
    });
    database.close();
  });
});
