import type {
  AuditEvent,
  Incident,
  IncidentDetail,
  IncidentStatus,
  ServiceHealth,
  TimelineEntry,
} from "../../shared/types.js";
import type { SqliteDatabase } from "../db/database.js";

interface IncidentRow {
  id: string;
  title: string;
  summary: string;
  severity: Incident["severity"];
  status: IncidentStatus;
  service: string;
  regions_json: string;
  customer_impact: string;
  affected_customers: number;
  assignee: string | null;
  started_at: string;
  updated_at: string;
}

interface TimelineRow {
  id: number;
  incident_id: string;
  occurred_at: string;
  kind: TimelineEntry["kind"];
  title: string;
  detail: string;
  author: string;
}

interface HealthRow {
  service: string;
  status: ServiceHealth["status"];
  latency_ms: number;
  error_rate: number;
  last_checked_at: string;
  detail: string;
}

interface AuditRow {
  id: number;
  incident_id: string | null;
  session_id: string | null;
  occurred_at: string;
  actor: string;
  action: string;
  arguments_json: string;
  outcome: AuditEvent["outcome"];
  detail: string;
}

interface MutationContext {
  sessionId: string;
  actor?: string;
  now?: string;
}

export class IncidentNotFoundError extends Error {
  constructor(incidentId: string) {
    super(`Incident ${incidentId} was not found.`);
    this.name = "IncidentNotFoundError";
  }
}

export class IncidentService {
  constructor(private readonly database: SqliteDatabase) {}

  listIncidents(): Incident[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM incidents
         ORDER BY
           CASE severity WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END,
           started_at DESC`,
      )
      .all() as IncidentRow[];
    return rows.map(mapIncident);
  }

  getIncident(incidentId: string): IncidentDetail {
    const row = this.database.prepare("SELECT * FROM incidents WHERE id = ?").get(incidentId) as
      | IncidentRow
      | undefined;
    if (!row) {
      throw new IncidentNotFoundError(incidentId);
    }

    const incident = mapIncident(row);
    return {
      ...incident,
      timeline: this.getTimeline(incidentId),
      serviceHealth: this.getServiceHealth(incident.service),
      auditEvents: this.getAuditEvents(incidentId),
    };
  }

  getTimeline(incidentId: string): TimelineEntry[] {
    this.assertIncident(incidentId);
    const rows = this.database
      .prepare(
        `SELECT * FROM timeline_entries
         WHERE incident_id = ?
         ORDER BY occurred_at ASC, id ASC`,
      )
      .all(incidentId) as TimelineRow[];
    return rows.map(mapTimeline);
  }

  getServiceHealth(primaryService?: string): ServiceHealth[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM service_health
         ORDER BY
           CASE WHEN service = @primaryService THEN 0 ELSE 1 END,
           CASE status WHEN 'outage' THEN 1 WHEN 'degraded' THEN 2 ELSE 3 END,
           service`,
      )
      .all({ primaryService: primaryService ?? "" }) as HealthRow[];
    return rows.map(mapHealth);
  }

  listRelatedIncidents(incidentId: string): Incident[] {
    const incident = this.getIncident(incidentId);
    return this.listIncidents().filter(
      (candidate) =>
        candidate.id !== incidentId &&
        (candidate.service === incident.service ||
          candidate.regions.some((region) => incident.regions.includes(region))),
    );
  }

  getAuditEvents(incidentId?: string): AuditEvent[] {
    const rows = (
      incidentId
        ? this.database
            .prepare(
              `SELECT * FROM audit_events
             WHERE incident_id = ? OR incident_id IS NULL
             ORDER BY occurred_at DESC, id DESC
             LIMIT 50`,
            )
            .all(incidentId)
        : this.database
            .prepare(
              `SELECT * FROM audit_events
             ORDER BY occurred_at DESC, id DESC
             LIMIT 100`,
            )
            .all()
    ) as AuditRow[];
    return rows.map(mapAudit);
  }

  assignIncident(incidentId: string, assignee: string, context: MutationContext): IncidentDetail {
    const cleanAssignee = assignee.trim();
    if (!cleanAssignee) {
      throw new Error("Assignee must not be empty.");
    }
    const now = context.now ?? new Date().toISOString();

    this.database.transaction(() => {
      this.assertIncident(incidentId);
      this.database
        .prepare("UPDATE incidents SET assignee = ?, updated_at = ? WHERE id = ?")
        .run(cleanAssignee, now, incidentId);
      this.recordAudit({
        incidentId,
        sessionId: context.sessionId,
        occurredAt: now,
        actor: context.actor ?? "copilot:incident-commander",
        action: "assign_incident",
        arguments: { incidentId, assignee: cleanAssignee },
        outcome: "success",
        detail: `Assigned ${incidentId} to ${cleanAssignee}.`,
      });
    })();

    return this.getIncident(incidentId);
  }

  updateIncidentStatus(
    incidentId: string,
    status: IncidentStatus,
    context: MutationContext,
  ): IncidentDetail {
    const now = context.now ?? new Date().toISOString();

    this.database.transaction(() => {
      const incident = this.getIncident(incidentId);
      this.database
        .prepare("UPDATE incidents SET status = ?, updated_at = ? WHERE id = ?")
        .run(status, now, incidentId);
      this.database
        .prepare(
          `INSERT INTO timeline_entries (
             incident_id, occurred_at, kind, title, detail, author
           ) VALUES (?, ?, 'status', ?, ?, ?)`,
        )
        .run(
          incidentId,
          now,
          `Status changed to ${status}`,
          `Incident status changed from ${incident.status} to ${status}.`,
          context.actor ?? "Incident Commander",
        );
      this.recordAudit({
        incidentId,
        sessionId: context.sessionId,
        occurredAt: now,
        actor: context.actor ?? "copilot:incident-commander",
        action: "update_incident_status",
        arguments: { incidentId, from: incident.status, to: status },
        outcome: "success",
        detail: `Changed ${incidentId} status from ${incident.status} to ${status}.`,
      });
    })();

    return this.getIncident(incidentId);
  }

  addTimelineNote(incidentId: string, note: string, context: MutationContext): IncidentDetail {
    const cleanNote = note.trim();
    if (!cleanNote) {
      throw new Error("Timeline note must not be empty.");
    }
    const now = context.now ?? new Date().toISOString();

    this.database.transaction(() => {
      this.assertIncident(incidentId);
      this.database
        .prepare(
          `INSERT INTO timeline_entries (
             incident_id, occurred_at, kind, title, detail, author
           ) VALUES (?, ?, 'note', 'Incident Commander note', ?, ?)`,
        )
        .run(incidentId, now, cleanNote, context.actor ?? "Incident Commander");
      this.database
        .prepare("UPDATE incidents SET updated_at = ? WHERE id = ?")
        .run(now, incidentId);
      this.recordAudit({
        incidentId,
        sessionId: context.sessionId,
        occurredAt: now,
        actor: context.actor ?? "copilot:incident-commander",
        action: "add_timeline_note",
        arguments: { incidentId, note: cleanNote },
        outcome: "success",
        detail: `Added a timeline note to ${incidentId}.`,
      });
    })();

    return this.getIncident(incidentId);
  }

  recordDecision(
    incidentId: string | null,
    sessionId: string,
    action: string,
    argumentsValue: Record<string, unknown>,
    outcome: "denied" | "error",
    detail: string,
  ): void {
    this.recordAudit({
      incidentId,
      sessionId,
      occurredAt: new Date().toISOString(),
      actor: "browser-user",
      action,
      arguments: argumentsValue,
      outcome,
      detail,
    });
  }

  createCopilotSession(sessionId: string, incidentId: string): void {
    this.assertIncident(incidentId);
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO copilot_sessions (id, incident_id, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET incident_id = excluded.incident_id, updated_at = excluded.updated_at`,
      )
      .run(sessionId, incidentId, now, now);
  }

  private assertIncident(incidentId: string): void {
    const row = this.database.prepare("SELECT 1 FROM incidents WHERE id = ?").get(incidentId);
    if (!row) {
      throw new IncidentNotFoundError(incidentId);
    }
  }

  private recordAudit(event: Omit<AuditEvent, "id">): void {
    this.database
      .prepare(
        `INSERT INTO audit_events (
           incident_id, session_id, occurred_at, actor, action, arguments_json, outcome, detail
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.incidentId,
        event.sessionId,
        event.occurredAt,
        event.actor,
        event.action,
        JSON.stringify(event.arguments),
        event.outcome,
        event.detail,
      );
  }
}

function mapIncident(row: IncidentRow): Incident {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    severity: row.severity,
    status: row.status,
    service: row.service,
    regions: JSON.parse(row.regions_json) as string[],
    customerImpact: row.customer_impact,
    affectedCustomers: row.affected_customers,
    assignee: row.assignee,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

function mapTimeline(row: TimelineRow): TimelineEntry {
  return {
    id: row.id,
    incidentId: row.incident_id,
    occurredAt: row.occurred_at,
    kind: row.kind,
    title: row.title,
    detail: row.detail,
    author: row.author,
  };
}

function mapHealth(row: HealthRow): ServiceHealth {
  return {
    service: row.service,
    status: row.status,
    latencyMs: row.latency_ms,
    errorRate: row.error_rate,
    lastCheckedAt: row.last_checked_at,
    detail: row.detail,
  };
}

function mapAudit(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    incidentId: row.incident_id,
    sessionId: row.session_id,
    occurredAt: row.occurred_at,
    actor: row.actor,
    action: row.action,
    arguments: JSON.parse(row.arguments_json) as Record<string, unknown>,
    outcome: row.outcome,
    detail: row.detail,
  };
}
