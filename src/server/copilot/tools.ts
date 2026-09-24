import { defineTool, type PermissionHandler } from "@github/copilot-sdk";
import { z } from "zod";

import type { ApprovalRequest, CommanderStreamEvent, IncidentStatus } from "../../shared/types.js";
import type { IncidentService } from "../domain/incident-service.js";
import type { ApprovalBroker } from "./approval-broker.js";

export const incidentToolNames = [
  "get_incident",
  "get_incident_timeline",
  "get_service_health",
  "list_related_incidents",
  "assign_incident",
  "update_incident_status",
  "add_timeline_note",
] as const;

const readToolNames = new Set<string>(incidentToolNames.slice(0, 4));
const writeToolNames = new Set<ApprovalRequest["toolName"]>([
  "assign_incident",
  "update_incident_status",
  "add_timeline_note",
]);

interface ToolContext {
  browserSessionId: string;
  incidentService: IncidentService;
  approvalBroker: ApprovalBroker;
  publish: (event: CommanderStreamEvent) => void;
}

export function createIncidentTools(context: ToolContext) {
  return [
    defineTool("get_incident", {
      description: "Get the current incident record, customer impact, assignment, and status.",
      parameters: z.object({
        incidentId: z.string().describe("Incident identifier, for example INC-1042"),
      }),
      skipPermission: true,
      defer: "never",
      handler: ({ incidentId }) => context.incidentService.getIncident(incidentId),
    }),
    defineTool("get_incident_timeline", {
      description: "Get the ordered incident timeline and operational evidence.",
      parameters: z.object({
        incidentId: z.string().describe("Incident identifier"),
      }),
      skipPermission: true,
      defer: "never",
      handler: ({ incidentId }) => context.incidentService.getTimeline(incidentId),
    }),
    defineTool("get_service_health", {
      description:
        "Get health, latency, and error-rate signals for affected and dependent services.",
      parameters: z.object({
        service: z.string().optional().describe("Primary service to prioritize in the result"),
      }),
      skipPermission: true,
      defer: "never",
      handler: ({ service }) => context.incidentService.getServiceHealth(service),
    }),
    defineTool("list_related_incidents", {
      description: "List other incidents that share a service or affected region.",
      parameters: z.object({
        incidentId: z.string().describe("Incident identifier"),
      }),
      skipPermission: true,
      defer: "never",
      handler: ({ incidentId }) => context.incidentService.listRelatedIncidents(incidentId),
    }),
    defineTool("assign_incident", {
      description:
        "Assign an incident to a named responder. This changes persisted incident state.",
      parameters: z.object({
        incidentId: z.string().describe("Incident identifier"),
        assignee: z.string().min(1).describe("Responder display name"),
      }),
      defer: "never",
      handler: ({ incidentId, assignee }) => {
        const incident = context.incidentService.assignIncident(incidentId, assignee, {
          sessionId: context.browserSessionId,
        });
        context.publish({ type: "data_changed", incidentId });
        return {
          success: true,
          incident: {
            id: incident.id,
            assignee: incident.assignee,
            status: incident.status,
            updatedAt: incident.updatedAt,
          },
        };
      },
    }),
    defineTool("update_incident_status", {
      description: "Change an incident workflow status. This changes persisted incident state.",
      parameters: z.object({
        incidentId: z.string().describe("Incident identifier"),
        status: z.enum(["Triggered", "Investigating", "Monitoring", "Resolved"]),
      }),
      defer: "never",
      handler: ({ incidentId, status }) => {
        const incident = context.incidentService.updateIncidentStatus(
          incidentId,
          status as IncidentStatus,
          { sessionId: context.browserSessionId },
        );
        context.publish({ type: "data_changed", incidentId });
        return {
          success: true,
          incident: {
            id: incident.id,
            assignee: incident.assignee,
            status: incident.status,
            updatedAt: incident.updatedAt,
          },
        };
      },
    }),
    defineTool("add_timeline_note", {
      description:
        "Add a concise operational note to the incident timeline. This changes persisted incident state.",
      parameters: z.object({
        incidentId: z.string().describe("Incident identifier"),
        note: z.string().min(1).max(600).describe("Timeline note text"),
      }),
      defer: "never",
      handler: ({ incidentId, note }) => {
        const incident = context.incidentService.addTimelineNote(incidentId, note, {
          sessionId: context.browserSessionId,
        });
        context.publish({ type: "data_changed", incidentId });
        return {
          success: true,
          incident: {
            id: incident.id,
            timelineEntryCount: incident.timeline.length,
            updatedAt: incident.updatedAt,
          },
        };
      },
    }),
  ];
}

export function createPermissionHandler(context: ToolContext): PermissionHandler {
  return async (request) => {
    if (request.kind !== "custom-tool") {
      return { kind: "reject", feedback: "Only Incident Commander domain tools are permitted." };
    }

    if (readToolNames.has(request.toolName)) {
      return { kind: "approved" };
    }

    if (!writeToolNames.has(request.toolName as ApprovalRequest["toolName"])) {
      return { kind: "reject", feedback: `Tool ${request.toolName} is not permitted.` };
    }

    const toolName = request.toolName as ApprovalRequest["toolName"];
    const argumentsValue = isRecord(request.args) ? request.args : {};
    const decision = await context.approvalBroker.request(
      context.browserSessionId,
      toolName,
      summarizeMutation(toolName, argumentsValue),
      argumentsValue,
    );

    if (!decision.approved) {
      const incidentId =
        typeof argumentsValue.incidentId === "string" ? argumentsValue.incidentId : null;
      context.incidentService.recordDecision(
        incidentId,
        context.browserSessionId,
        toolName,
        argumentsValue,
        "denied",
        `Browser user denied ${toolName}.`,
      );
      return {
        kind: "reject",
        feedback: "The browser user denied this state-changing action.",
      };
    }

    return { kind: "approved" };
  };
}

function summarizeMutation(
  toolName: ApprovalRequest["toolName"],
  argumentsValue: Record<string, unknown>,
): string {
  const incidentId = String(argumentsValue.incidentId ?? "the incident");
  switch (toolName) {
    case "assign_incident":
      return `Assign ${incidentId} to ${String(argumentsValue.assignee ?? "the proposed responder")}`;
    case "update_incident_status":
      return `Change ${incidentId} status to ${String(argumentsValue.status ?? "the proposed status")}`;
    case "add_timeline_note":
      return `Add a timeline note to ${incidentId}`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
