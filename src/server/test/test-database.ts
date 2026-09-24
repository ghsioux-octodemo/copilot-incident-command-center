import { openDatabase, resetDatabase } from "../db/database.js";
import { IncidentService } from "../domain/incident-service.js";

export function createTestContext() {
  const database = openDatabase(":memory:");
  resetDatabase(database);
  return {
    database,
    incidentService: new IncidentService(database),
  };
}
