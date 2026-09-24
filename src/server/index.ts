import http from "node:http";

import { ApprovalBroker } from "./copilot/approval-broker.js";
import { CopilotManager } from "./copilot/copilot-manager.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { ensureSeeded, openDatabase } from "./db/database.js";
import { IncidentService } from "./domain/incident-service.js";

const config = loadConfig();
const database = openDatabase(config.databasePath);
ensureSeeded(database);
const incidentService = new IncidentService(database);
const approvalBroker = new ApprovalBroker();
const copilotManager = new CopilotManager(config, incidentService, approvalBroker);
const app = createApp({ database, incidentService, copilotManager });
const server = http.createServer(app);

server.listen(config.port, () => {
  console.log(`Incident Command Center listening on http://localhost:${config.port}`);
  void copilotManager.warmup();
});

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}; shutting down.`);
  server.close();
  await copilotManager.stop();
  database.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
