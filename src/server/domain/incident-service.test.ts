import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SqliteDatabase } from "../db/database.js";
import { createTestContext } from "../test/test-database.js";
import { IncidentService } from "./incident-service.js";

describe("IncidentService", () => {
  let database: SqliteDatabase;
  let service: IncidentService;

  beforeEach(() => {
    const context = createTestContext();
    database = context.database;
    service = context.incidentService;
  });

  afterEach(() => database.close());

  it("returns the canonical P1 checkout incident with operational evidence", () => {
    const incident = service.getIncident("INC-1042");

    expect(incident.severity).toBe("P1");
    expect(incident.status).toBe("Triggered");
    expect(incident.affectedCustomers).toBe(18420);
    expect(incident.timeline.map((entry) => entry.title)).toContain(
      "Token-cache hit rate collapsed",
    );
    expect(incident.serviceHealth[0].service).toBe("Checkout API");
  });

  it("persists assignment, status, timeline, and correlated audit updates", () => {
    service.assignIncident("INC-1042", "Maya Patel", {
      sessionId: "session-123",
      now: "2026-09-24T12:10:00.000Z",
    });
    service.updateIncidentStatus("INC-1042", "Investigating", {
      sessionId: "session-123",
      now: "2026-09-24T12:11:00.000Z",
    });
    const updated = service.addTimelineNote(
      "INC-1042",
      "Validating rollback of payment-service v4.18.0.",
      {
        sessionId: "session-123",
        now: "2026-09-24T12:12:00.000Z",
      },
    );

    expect(updated.assignee).toBe("Maya Patel");
    expect(updated.status).toBe("Investigating");
    expect(updated.timeline.at(-1)?.detail).toContain("Validating rollback");
    expect(updated.auditEvents.slice(0, 3).map((event) => event.action)).toEqual([
      "add_timeline_note",
      "update_incident_status",
      "assign_incident",
    ]);
    expect(updated.auditEvents[0].sessionId).toBe("session-123");
  });

  it("finds related incidents without exposing database access", () => {
    const related = service.listRelatedIncidents("INC-1042");

    expect(related.map((incident) => incident.id)).toContain("INC-1041");
    expect(related.map((incident) => incident.id)).not.toContain("INC-1042");
  });
});
