export type IncidentSeverity = "P1" | "P2" | "P3" | "P4";
export type IncidentStatus = "Triggered" | "Investigating" | "Monitoring" | "Resolved";

export interface Incident {
  id: string;
  title: string;
  summary: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  service: string;
  regions: string[];
  customerImpact: string;
  affectedCustomers: number;
  assignee: string | null;
  startedAt: string;
  updatedAt: string;
}

export interface TimelineEntry {
  id: number;
  incidentId: string;
  occurredAt: string;
  kind: "signal" | "deployment" | "note" | "status";
  title: string;
  detail: string;
  author: string;
}

export interface ServiceHealth {
  service: string;
  status: "healthy" | "degraded" | "outage";
  latencyMs: number;
  errorRate: number;
  lastCheckedAt: string;
  detail: string;
}

export interface AuditEvent {
  id: number;
  incidentId: string | null;
  sessionId: string | null;
  occurredAt: string;
  actor: string;
  action: string;
  arguments: Record<string, unknown>;
  outcome: "success" | "denied" | "error";
  detail: string;
}

export interface IncidentDetail extends Incident {
  timeline: TimelineEntry[];
  serviceHealth: ServiceHealth[];
  auditEvents: AuditEvent[];
}

export type CopilotHealthStatus = "unconfigured" | "configured" | "healthy" | "error";

export interface CopilotHealth {
  status: CopilotHealthStatus;
  message: string;
  checkedAt: string;
}

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  toolName: "assign_incident" | "update_incident_status" | "add_timeline_note";
  summary: string;
  arguments: Record<string, unknown>;
  createdAt: string;
}

export type CommanderStreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "assistant_delta"; delta: string }
  | { type: "assistant_complete"; content: string }
  | {
      type: "tool_started";
      toolCallId: string;
      toolName: string;
      arguments?: unknown;
      label: string;
    }
  | {
      type: "tool_completed";
      toolCallId: string;
      toolName: string;
      success: boolean;
      label: string;
    }
  | { type: "approval_required"; approval: ApprovalRequest }
  | { type: "approval_resolved"; approvalId: string; decision: "approved" | "denied" }
  | { type: "data_changed"; incidentId: string }
  | { type: "error"; message: string; code?: string }
  | { type: "done" };
