import { describe, expect, it } from "vitest";

import { resetDatabase } from "./database.js";
import { createTestContext } from "../test/test-database.js";

describe("resetDatabase", () => {
  it("restores the canonical dataset deterministically after mutations", () => {
    const { database, incidentService } = createTestContext();
    const canonical = incidentService.getIncident("INC-1042");

    incidentService.assignIncident("INC-1042", "Maya Patel", {
      sessionId: "session-reset",
    });
    incidentService.updateIncidentStatus("INC-1042", "Investigating", {
      sessionId: "session-reset",
    });
    incidentService.addTimelineNote("INC-1042", "Temporary demo note", {
      sessionId: "session-reset",
    });

    resetDatabase(database);
    const firstReset = incidentService.getIncident("INC-1042");
    resetDatabase(database);
    const secondReset = incidentService.getIncident("INC-1042");

    expect(firstReset).toEqual(canonical);
    expect(secondReset).toEqual(canonical);
    expect(firstReset.assignee).toBeNull();
    expect(firstReset.status).toBe("Triggered");
    expect(firstReset.auditEvents).toHaveLength(1);
    database.close();
  });
});
