import type {
  ApprovalRequest,
  CommanderStreamEvent,
  CopilotHealth,
  Incident,
  IncidentDetail,
} from "../shared/types";

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `Request failed with HTTP ${response.status}.`);
  }
  return body;
}

export async function listIncidents(): Promise<Incident[]> {
  const result = await jsonRequest<{ incidents: Incident[] }>("/api/incidents");
  return result.incidents;
}

export async function getIncident(incidentId: string): Promise<IncidentDetail> {
  const result = await jsonRequest<{ incident: IncidentDetail }>(
    `/api/incidents/${encodeURIComponent(incidentId)}`,
  );
  return result.incident;
}

export function getCopilotHealth(): Promise<CopilotHealth> {
  return jsonRequest<CopilotHealth>("/api/health/copilot");
}

export async function createCommanderSession(incidentId: string): Promise<string> {
  const result = await jsonRequest<{ sessionId: string }>("/api/copilot/sessions", {
    method: "POST",
    body: JSON.stringify({ incidentId }),
  });
  return result.sessionId;
}

export async function sendCommanderMessage(
  sessionId: string,
  incidentId: string,
  prompt: string,
  onEvent: (event: CommanderStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`/api/copilot/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ incidentId, prompt }),
    signal,
  });
  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Message request failed with HTTP ${response.status}.`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine) {
        onEvent(JSON.parse(dataLine.slice(6)) as CommanderStreamEvent);
      }
    }
    if (done) {
      break;
    }
  }
}

export async function resolveApproval(
  sessionId: string,
  approval: ApprovalRequest,
  decision: "approve" | "deny",
): Promise<void> {
  await jsonRequest(
    `/api/copilot/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approval.id)}`,
    {
      method: "POST",
      body: JSON.stringify({ decision }),
    },
  );
}

export async function resetDemoData(): Promise<Incident[]> {
  const result = await jsonRequest<{ incidents: Incident[] }>("/api/demo/reset", {
    method: "POST",
    body: JSON.stringify({ confirmation: "RESET" }),
  });
  return result.incidents;
}
