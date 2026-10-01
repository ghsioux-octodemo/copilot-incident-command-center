import {
  AlertCircle,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  LoaderCircle,
  Send,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

import type {
  ApprovalRequest,
  CommanderStreamEvent,
  CopilotHealth,
  CopilotModel,
  IncidentDetail,
} from "../../shared/types";
import {
  createCommanderSession,
  listCopilotModels,
  resolveApproval,
  sendCommanderMessage,
} from "../api";

const BRIEF_PROMPT = "Brief me on this incident and identify the most likely cause.";
const ACTION_PROMPT =
  "Assign this incident to Maya Patel, change the status to Investigating, and add a timeline note that the team is validating a rollback of payment-service v4.18.0.";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  error?: boolean;
}

interface Activity {
  id: string;
  toolName: string;
  label: string;
  status: "running" | "success" | "failed";
}

interface CommanderPanelProps {
  incident: IncidentDetail;
  health: CopilotHealth | null;
  onDataChanged: () => Promise<void>;
}

interface ConversationState {
  sessionId?: string;
  messages: Message[];
  activities: Activity[];
  pendingApprovals: ApprovalRequest[];
  denialMessage?: string;
  prompt: string;
  isStreaming: boolean;
}

const EMPTY_STATE: ConversationState = {
  messages: [],
  activities: [],
  pendingApprovals: [],
  prompt: "",
  isStreaming: false,
};

export function CommanderPanel({ incident, health, onDataChanged }: CommanderPanelProps) {
  // State is kept per incident so switching incidents (even mid-stream) never loses it.
  const [states, setStates] = useState<Record<string, ConversationState>>({});
  const incidentId = incident.id;
  const { sessionId, messages, activities, pendingApprovals, denialMessage, prompt, isStreaming } =
    states[incidentId] ?? EMPTY_STATE;
  const pendingApproval = pendingApprovals[0];
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [models, setModels] = useState<CopilotModel[]>([]);
  const [model, setModel] = useState(() => localStorage.getItem("commander-model") ?? "");
  const messageEndRef = useRef<HTMLDivElement>(null);

  function patch(
    id: string,
    update: (state: ConversationState) => Partial<ConversationState>,
  ): void {
    setStates((all) => {
      const state = all[id] ?? EMPTY_STATE;
      return { ...all, [id]: { ...state, ...update(state) } };
    });
  }

  function setPrompt(value: string): void {
    patch(incidentId, () => ({ prompt: value }));
  }

  useEffect(() => {
    setApprovalBusy(false);
  }, [incidentId]);

  useEffect(() => {
    if (health?.status !== "healthy") {
      return;
    }
    listCopilotModels()
      .then(({ models: available, defaultModel }) => {
        setModels(available);
        setModel((current) =>
          available.some((item) => item.id === current) ? current : defaultModel,
        );
      })
      .catch(() => setModels([]));
  }, [health?.status]);

  function changeModel(value: string): void {
    setModel(value);
    localStorage.setItem("commander-model", value);
  }

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activities, pendingApproval?.id]);

  const canSend = health?.status === "healthy" && !isStreaming;

  async function sendPrompt(value: string): Promise<void> {
    const cleanPrompt = value.trim();
    if (!cleanPrompt || !canSend) {
      return;
    }

    const id = incidentId;
    const assistantMessageId = crypto.randomUUID();
    patch(id, (state) => ({
      prompt: "",
      denialMessage: undefined,
      activities: [],
      isStreaming: true,
      messages: [
        ...state.messages,
        { id: crypto.randomUUID(), role: "user", content: cleanPrompt },
        { id: assistantMessageId, role: "assistant", content: "" },
      ],
    }));

    const updateMessage = (update: (message: Message) => Message): void =>
      patch(id, (state) => ({
        messages: state.messages.map((message) =>
          message.id === assistantMessageId ? update(message) : message,
        ),
      }));

    try {
      const activeSessionId = sessionId ?? (await createCommanderSession(id));
      if (!sessionId) {
        patch(id, () => ({ sessionId: activeSessionId }));
      }
      await sendCommanderMessage(
        activeSessionId,
        id,
        cleanPrompt,
        (event) => handleStreamEvent(event, id, updateMessage),
        model || undefined,
      );
    } catch (error) {
      updateMessage((message) => ({
        ...message,
        content: error instanceof Error ? error.message : String(error),
        error: true,
      }));
    } finally {
      patch(id, () => ({ pendingApprovals: [], isStreaming: false }));
    }
  }

  function handleStreamEvent(
    event: CommanderStreamEvent,
    id: string,
    updateMessage: (update: (message: Message) => Message) => void,
  ): void {
    switch (event.type) {
      case "assistant_delta":
        updateMessage((message) => ({ ...message, content: message.content + event.delta }));
        break;
      case "assistant_complete":
        updateMessage((message) =>
          message.content ? message : { ...message, content: event.content },
        );
        break;
      case "tool_started":
        patch(id, (state) => ({
          activities: [
            ...state.activities.filter((activity) => activity.id !== event.toolCallId),
            {
              id: event.toolCallId,
              toolName: event.toolName,
              label: event.label,
              status: "running",
            },
          ],
        }));
        break;
      case "tool_completed":
        patch(id, (state) => ({
          activities: state.activities.map((activity) =>
            activity.id === event.toolCallId
              ? { ...activity, label: event.label, status: event.success ? "success" : "failed" }
              : activity,
          ),
        }));
        break;
      case "approval_required":
        patch(id, (state) => ({
          pendingApprovals: state.pendingApprovals.some(
            (approval) => approval.id === event.approval.id,
          )
            ? state.pendingApprovals
            : [...state.pendingApprovals, event.approval],
        }));
        break;
      case "approval_resolved":
        patch(id, (state) => ({
          pendingApprovals: state.pendingApprovals.filter(
            (approval) => approval.id !== event.approvalId,
          ),
        }));
        break;
      case "data_changed":
        void onDataChanged();
        break;
      case "error":
        updateMessage((message) => ({
          ...message,
          content: message.content || event.message,
          error: true,
        }));
        break;
    }
  }

  async function decideApproval(decision: "approve" | "deny"): Promise<void> {
    if (!pendingApproval || !sessionId) {
      return;
    }
    const id = incidentId;
    const approval = pendingApproval;
    setApprovalBusy(true);
    try {
      await resolveApproval(sessionId, approval, decision);
      patch(id, (state) => ({
        denialMessage:
          decision === "deny"
            ? `Denied: ${approval.summary}. No incident data was changed.`
            : state.denialMessage,
        pendingApprovals: state.pendingApprovals.filter((item) => item.id !== approval.id),
      }));
    } catch (error) {
      patch(id, () => ({
        denialMessage: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setApprovalBusy(false);
    }
  }

  return (
    <aside className="commander-panel">
      <div className="commander-header">
        <div className="commander-avatar">
          <Bot size={20} />
        </div>
        <div>
          <div className="eyebrow">GitHub Copilot SDK</div>
          <h2>Incident Commander</h2>
        </div>
        {models.length > 0 && (
          <select
            className="model-select"
            aria-label="LLM model"
            value={model}
            disabled={isStreaming}
            onChange={(event) => changeModel(event.target.value)}
          >
            {models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        )}
        <span
          className={`presence-dot ${health?.status === "healthy" ? "online" : ""}`}
          title={health?.message}
        />
      </div>

      <div className="commander-body">
        {messages.length === 0 && (
          <div className="commander-welcome">
            <Sparkles size={24} />
            <h3>Operational context, on demand</h3>
            <p>
              Incident Commander reads trusted incident tools automatically and asks before changing
              state.
            </p>
            <button
              className="suggestion-card"
              disabled={!canSend}
              onClick={() => void sendPrompt(BRIEF_PROMPT)}
            >
              <span>
                <strong>Start the briefing</strong>
                {BRIEF_PROMPT}
              </span>
              <ChevronRight size={18} />
            </button>
            <button
              className="suggestion-card secondary"
              disabled={!canSend}
              onClick={() => void sendPrompt(ACTION_PROMPT)}
            >
              <span>
                <strong>Coordinate response</strong>
                Propose assignment, status, and timeline updates
              </span>
              <ChevronRight size={18} />
            </button>
          </div>
        )}

        {messages.map((message) => (
          <div
            className={`chat-message ${message.role} ${message.error ? "error" : ""}`}
            key={message.id}
          >
            <div className="message-role">
              {message.role === "assistant" ? (
                <>
                  <Bot size={15} /> Incident Commander
                </>
              ) : (
                "You"
              )}
            </div>
            {message.role === "assistant" ? (
              message.content ? (
                <ReactMarkdown>{message.content}</ReactMarkdown>
              ) : (
                <div className="thinking-row">
                  <LoaderCircle className="spin" size={16} />
                  Reviewing operational context…
                </div>
              )
            ) : (
              <p>{message.content}</p>
            )}
          </div>
        ))}

        {activities.length > 0 && (
          <div className="activity-stack">
            <div className="activity-heading">Agent activity</div>
            {activities.map((activity) => (
              <div className="activity-row" key={activity.id}>
                {activity.status === "running" ? (
                  <LoaderCircle className="spin" size={15} />
                ) : activity.status === "success" ? (
                  <CheckCircle2 size={15} />
                ) : (
                  <AlertCircle size={15} />
                )}
                <span>{activity.label}</span>
                <code>{activity.toolName}</code>
              </div>
            ))}
          </div>
        )}

        {pendingApproval && (
          <div className="approval-card">
            <div className="approval-title">
              <ShieldCheck size={19} />
              <div>
                <span>
                  Approval required
                  {pendingApprovals.length > 1 && ` · 1 of ${pendingApprovals.length}`}
                </span>
                <strong>{pendingApproval.summary}</strong>
              </div>
            </div>
            <div className="approval-arguments">
              {Object.entries(pendingApproval.arguments).map(([key, value]) => (
                <div key={key}>
                  <span>{humanize(key)}</span>
                  <strong>{String(value)}</strong>
                </div>
              ))}
            </div>
            <p>This exact mutation will run only once if approved.</p>
            <div className="approval-actions">
              <button
                className="button danger-ghost"
                disabled={approvalBusy}
                onClick={() => void decideApproval("deny")}
              >
                <X size={16} /> Deny
              </button>
              <button
                className="button approve"
                disabled={approvalBusy}
                onClick={() => void decideApproval("approve")}
              >
                {approvalBusy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
                Approve once
              </button>
            </div>
          </div>
        )}

        {denialMessage && (
          <div className="denial-state">
            <Circle size={9} fill="currentColor" />
            {denialMessage}
          </div>
        )}
        <div ref={messageEndRef} />
      </div>

      <form
        className="commander-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void sendPrompt(prompt);
        }}
      >
        <textarea
          aria-label="Ask Incident Commander"
          value={prompt}
          placeholder={
            health?.status === "healthy"
              ? "Ask about this incident or request an action…"
              : "Configure Copilot authentication to enable Incident Commander"
          }
          disabled={!canSend}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void sendPrompt(prompt);
            }
          }}
        />
        <button
          aria-label="Send message"
          className="send-button"
          disabled={!canSend || !prompt.trim()}
          type="submit"
        >
          {isStreaming ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}
        </button>
        <div className="composer-footnote">
          Read tools run automatically. Changes always require your approval.
        </div>
      </form>
    </aside>
  );
}

function humanize(value: string): string {
  return value.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase());
}
