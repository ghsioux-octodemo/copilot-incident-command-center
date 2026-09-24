import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { seedAuditEvents, seedIncidents, seedServiceHealth, seedTimeline } from "../domain/seed.js";

export type SqliteDatabase = InstanceType<typeof Database>;

export function openDatabase(databasePath: string): SqliteDatabase {
  if (databasePath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  }

  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  migrateDatabase(database);
  return database;
}

export function migrateDatabase(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      severity TEXT NOT NULL,
      status TEXT NOT NULL,
      service TEXT NOT NULL,
      regions_json TEXT NOT NULL,
      customer_impact TEXT NOT NULL,
      affected_customers INTEGER NOT NULL,
      assignee TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS timeline_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      occurred_at TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      author TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS service_health (
      service TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      latency_ms INTEGER NOT NULL,
      error_rate REAL NOT NULL,
      last_checked_at TEXT NOT NULL,
      detail TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id TEXT REFERENCES incidents(id) ON DELETE SET NULL,
      session_id TEXT,
      occurred_at TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      outcome TEXT NOT NULL,
      detail TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS copilot_sessions (
      id TEXT PRIMARY KEY,
      incident_id TEXT REFERENCES incidents(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS timeline_incident_time
      ON timeline_entries(incident_id, occurred_at);
    CREATE INDEX IF NOT EXISTS audit_incident_time
      ON audit_events(incident_id, occurred_at);
  `);
}

export function resetDatabase(database: SqliteDatabase): void {
  const reset = database.transaction(() => {
    database.exec(`
      DELETE FROM copilot_sessions;
      DELETE FROM audit_events;
      DELETE FROM timeline_entries;
      DELETE FROM service_health;
      DELETE FROM incidents;
      DELETE FROM sqlite_sequence WHERE name IN ('timeline_entries', 'audit_events');
    `);

    const insertIncident = database.prepare(`
      INSERT INTO incidents (
        id, title, summary, severity, status, service, regions_json, customer_impact,
        affected_customers, assignee, started_at, updated_at
      ) VALUES (
        @id, @title, @summary, @severity, @status, @service, @regionsJson, @customerImpact,
        @affectedCustomers, @assignee, @startedAt, @updatedAt
      )
    `);

    for (const incident of seedIncidents) {
      insertIncident.run({ ...incident, regionsJson: JSON.stringify(incident.regions) });
    }

    const insertTimeline = database.prepare(`
      INSERT INTO timeline_entries (
        incident_id, occurred_at, kind, title, detail, author
      ) VALUES (
        @incidentId, @occurredAt, @kind, @title, @detail, @author
      )
    `);
    for (const entry of seedTimeline) {
      insertTimeline.run(entry);
    }

    const insertHealth = database.prepare(`
      INSERT INTO service_health (
        service, status, latency_ms, error_rate, last_checked_at, detail
      ) VALUES (
        @service, @status, @latencyMs, @errorRate, @lastCheckedAt, @detail
      )
    `);
    for (const health of seedServiceHealth) {
      insertHealth.run(health);
    }

    const insertAudit = database.prepare(`
      INSERT INTO audit_events (
        incident_id, session_id, occurred_at, actor, action, arguments_json, outcome, detail
      ) VALUES (
        @incidentId, @sessionId, @occurredAt, @actor, @action, @argumentsJson, @outcome, @detail
      )
    `);
    for (const event of seedAuditEvents) {
      insertAudit.run({ ...event, argumentsJson: JSON.stringify(event.arguments) });
    }
  });

  reset();
}

export function ensureSeeded(database: SqliteDatabase): void {
  const row = database.prepare("SELECT COUNT(*) AS count FROM incidents").get() as {
    count: number;
  };
  if (row.count === 0) {
    resetDatabase(database);
  }
}
