import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock3,
  Database,
  Globe2,
  History,
  LoaderCircle,
  MapPin,
  Radio,
  RefreshCw,
  Server,
  ShieldAlert,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  CopilotHealth,
  Incident,
  IncidentDetail,
  IncidentSeverity,
  IncidentStatus,
} from "../shared/types";
import { getCopilotHealth, getIncident, listIncidents, resetDemoData } from "./api";
import { CommanderPanel } from "./components/CommanderPanel";

export function App() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [selectedId, setSelectedId] = useState("INC-1042");
  const [detail, setDetail] = useState<IncidentDetail>();
  const [health, setHealth] = useState<CopilotHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [showReset, setShowReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [demoGeneration, setDemoGeneration] = useState(0);

  const loadDetail = useCallback(async (incidentId: string) => {
    setDetailLoading(true);
    try {
      setDetail(await getIncident(incidentId));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const refreshSelected = useCallback(async () => {
    const [nextIncidents, nextDetail] = await Promise.all([
      listIncidents(),
      getIncident(selectedId),
    ]);
    setIncidents(nextIncidents);
    setDetail(nextDetail);
  }, [selectedId]);

  useEffect(() => {
    void Promise.all([listIncidents(), getCopilotHealth()])
      .then(([nextIncidents, nextHealth]) => {
        setIncidents(nextIncidents);
        setHealth(nextHealth);
        const initialId = nextIncidents.some((incident) => incident.id === selectedId)
          ? selectedId
          : nextIncidents[0]?.id;
        if (initialId) {
          setSelectedId(initialId);
          return loadDetail(initialId);
        }
      })
      .catch((caughtError: unknown) => {
        setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
      })
      .finally(() => setLoading(false));
  }, [loadDetail, selectedId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void getCopilotHealth()
        .then(setHealth)
        .catch(() => undefined);
    }, 15000);
    return () => window.clearInterval(timer);
  }, []);

  const activeCount = useMemo(
    () => incidents.filter((incident) => incident.status !== "Resolved").length,
    [incidents],
  );

  async function selectIncident(incidentId: string): Promise<void> {
    setSelectedId(incidentId);
    setError(undefined);
    try {
      await loadDetail(incidentId);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    }
  }

  async function reset(): Promise<void> {
    setResetting(true);
    try {
      const nextIncidents = await resetDemoData();
      setIncidents(nextIncidents);
      setSelectedId("INC-1042");
      await loadDetail("INC-1042");
      setDemoGeneration((current) => current + 1);
      setShowReset(false);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    } finally {
      setResetting(false);
    }
  }

  if (loading) {
    return (
      <div className="page-state">
        <LoaderCircle className="spin" size={30} />
        <strong>Loading the command center…</strong>
      </div>
    );
  }

  if (error && incidents.length === 0) {
    return (
      <div className="page-state error">
        <ShieldAlert size={34} />
        <strong>Unable to load incident data</strong>
        <p>{error}</p>
        <button className="button" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Radio size={21} />
          </div>
          <div>
            <span>Northstar Commerce</span>
            <strong>Incident Command Center</strong>
          </div>
        </div>
        <div className="topbar-actions">
          <div className={`health-badge ${health?.status ?? "unconfigured"}`}>
            <span />
            <div>
              <strong>Copilot {health?.status ?? "checking"}</strong>
              <small>
                {health?.status === "healthy"
                  ? health.authMode === "user-token"
                    ? "User token · user attributed"
                    : "GitHub App · org attributed"
                  : (health?.message ?? "Checking authentication")}
              </small>
            </div>
          </div>
          <button className="reset-button" onClick={() => setShowReset(true)}>
            <RefreshCw size={15} />
            Reset demo data
          </button>
        </div>
      </header>

      <div className="workspace">
        <nav className="incident-rail">
          <div className="rail-heading">
            <div>
              <span className="eyebrow">Operations</span>
              <h1>Incidents</h1>
            </div>
            <span className="active-count">{activeCount} active</span>
          </div>
          <div className="incident-list">
            {incidents.length === 0 ? (
              <div className="empty-state">
                <CheckCircle2 size={26} />
                <strong>No incidents</strong>
                <span>All services are operating normally.</span>
              </div>
            ) : (
              incidents.map((incident) => (
                <button
                  className={`incident-card ${selectedId === incident.id ? "selected" : ""}`}
                  key={incident.id}
                  onClick={() => void selectIncident(incident.id)}
                >
                  <div className="incident-card-top">
                    <SeverityBadge severity={incident.severity} />
                    <StatusBadge status={incident.status} />
                    <ChevronRight size={16} />
                  </div>
                  <strong>{incident.title}</strong>
                  <p>{incident.summary}</p>
                  <div className="incident-card-meta">
                    <span>
                      <Server size={13} /> {incident.service}
                    </span>
                    <span>
                      <Clock3 size={13} /> {timeAgo(incident.updatedAt)}
                    </span>
                  </div>
                </button>
              ))
            )}
          </div>
        </nav>

        <main className="incident-main">
          {detailLoading && !detail ? (
            <div className="detail-loading">
              <LoaderCircle className="spin" size={24} />
            </div>
          ) : detail ? (
            <IncidentView incident={detail} />
          ) : (
            <div className="empty-state large">
              <CircleDot size={30} />
              <strong>Select an incident</strong>
              <span>Choose an incident to view operational context.</span>
            </div>
          )}
        </main>

        {detail && (
          <CommanderPanel
            key={`${detail.id}-${demoGeneration}`}
            health={health}
            incident={detail}
            onDataChanged={refreshSelected}
          />
        )}
      </div>

      {error && (
        <div className="toast-error">
          <AlertTriangle size={17} />
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={() => setError(undefined)}>
            <X size={16} />
          </button>
        </div>
      )}

      {showReset && (
        <div className="modal-backdrop" role="presentation">
          <div className="confirmation-modal" role="dialog" aria-modal="true">
            <div className="modal-icon">
              <Database size={22} />
            </div>
            <h2>Reset demo data?</h2>
            <p>
              This restores every incident, status, assignment, timeline entry, and audit event to
              the canonical demo state.
            </p>
            <div className="modal-actions">
              <button className="button ghost" onClick={() => setShowReset(false)}>
                Cancel
              </button>
              <button className="button danger" disabled={resetting} onClick={() => void reset()}>
                {resetting && <LoaderCircle className="spin" size={16} />}
                Reset everything
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function IncidentView({ incident }: { incident: IncidentDetail }) {
  return (
    <div className="incident-detail">
      <div className="detail-hero">
        <div className="detail-title-row">
          <div>
            <div className="detail-badges">
              <SeverityBadge severity={incident.severity} />
              <StatusBadge status={incident.status} />
              <span className="incident-id">{incident.id}</span>
            </div>
            <h2>{incident.title}</h2>
            <p>{incident.summary}</p>
          </div>
          <div className="impact-number">
            <strong>{incident.affectedCustomers.toLocaleString()}</strong>
            <span>customers affected</span>
          </div>
        </div>
        <div className="facts-grid">
          <Fact icon={<Server size={16} />} label="Service" value={incident.service} />
          <Fact icon={<MapPin size={16} />} label="Regions" value={incident.regions.join(", ")} />
          <Fact
            icon={<UserRound size={16} />}
            label="Commander"
            value={incident.assignee ?? "Unassigned"}
          />
          <Fact
            icon={<Clock3 size={16} />}
            label="Started"
            value={formatDateTime(incident.startedAt)}
          />
        </div>
      </div>

      <section className="impact-banner">
        <UsersRound size={20} />
        <div>
          <span>Customer impact</span>
          <strong>{incident.customerImpact}</strong>
        </div>
      </section>

      <div className="detail-columns">
        <section className="content-card timeline-card">
          <div className="section-heading">
            <div>
              <Activity size={18} />
              <h3>Incident timeline</h3>
            </div>
            <span>{incident.timeline.length} events</span>
          </div>
          <div className="timeline">
            {incident.timeline.map((entry) => (
              <div className={`timeline-entry ${entry.kind}`} key={entry.id}>
                <div className="timeline-marker" />
                <div className="timeline-content">
                  <time>{formatTime(entry.occurredAt)}</time>
                  <strong>{entry.title}</strong>
                  <p>{entry.detail}</p>
                  <span>{entry.author}</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        <div className="detail-side-stack">
          <section className="content-card">
            <div className="section-heading">
              <div>
                <Globe2 size={18} />
                <h3>Service health</h3>
              </div>
              <span>Live demo adapter</span>
            </div>
            <div className="health-list">
              {incident.serviceHealth.slice(0, 4).map((service) => (
                <div className="service-health-row" key={service.service}>
                  <span className={`service-dot ${service.status}`} />
                  <div>
                    <strong>{service.service}</strong>
                    <span>{service.detail}</span>
                  </div>
                  <div className="service-metrics">
                    <strong>{formatLatency(service.latencyMs)}</strong>
                    <span>{service.errorRate}% errors</span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="content-card audit-card">
            <div className="section-heading">
              <div>
                <History size={18} />
                <h3>Audit activity</h3>
              </div>
              <span>Persistent</span>
            </div>
            <div className="audit-list">
              {incident.auditEvents.map((event) => (
                <div className="audit-row" key={event.id}>
                  <div className={`audit-icon ${event.outcome}`}>
                    {event.outcome === "success" ? (
                      <CheckCircle2 size={14} />
                    ) : (
                      <AlertTriangle size={14} />
                    )}
                  </div>
                  <div>
                    <strong>{event.detail}</strong>
                    <span>
                      {event.actor} · {formatDateTime(event.occurredAt)}
                      {event.sessionId ? ` · ${event.sessionId.slice(0, 8)}` : ""}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: IncidentSeverity }) {
  return <span className={`severity-badge ${severity.toLowerCase()}`}>{severity}</span>;
}

function StatusBadge({ status }: { status: IncidentStatus }) {
  return <span className={`status-badge ${status.toLowerCase()}`}>{status}</span>;
}

function Fact({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="fact">
      {icon}
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function timeAgo(value: string): string {
  const minutes = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatLatency(milliseconds: number): string {
  return milliseconds > 10000
    ? `${Math.round(milliseconds / 60000)}m`
    : `${milliseconds.toLocaleString()} ms`;
}
