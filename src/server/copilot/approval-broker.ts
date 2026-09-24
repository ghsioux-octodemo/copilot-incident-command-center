import { randomUUID } from "node:crypto";

import type { ApprovalRequest, CommanderStreamEvent } from "../../shared/types.js";

export interface ApprovalDecision {
  approved: boolean;
  approval: ApprovalRequest;
}

interface PendingApproval {
  approval: ApprovalRequest;
  timer: NodeJS.Timeout;
  resolve: (decision: ApprovalDecision) => void;
}

type StreamPublisher = (event: CommanderStreamEvent) => void;

export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly publishers = new Map<string, StreamPublisher>();

  attachPublisher(sessionId: string, publisher: StreamPublisher): () => void {
    this.publishers.set(sessionId, publisher);
    return () => {
      if (this.publishers.get(sessionId) === publisher) {
        this.publishers.delete(sessionId);
      }
    };
  }

  async request(
    sessionId: string,
    toolName: ApprovalRequest["toolName"],
    summary: string,
    argumentsValue: Record<string, unknown>,
    timeoutMs = 5 * 60 * 1000,
  ): Promise<ApprovalDecision> {
    const publisher = this.publishers.get(sessionId);
    if (!publisher) {
      return {
        approved: false,
        approval: {
          id: randomUUID(),
          sessionId,
          toolName,
          summary,
          arguments: argumentsValue,
          createdAt: new Date().toISOString(),
        },
      };
    }

    const approval: ApprovalRequest = {
      id: randomUUID(),
      sessionId,
      toolName,
      summary,
      arguments: argumentsValue,
      createdAt: new Date().toISOString(),
    };

    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(approval.id);
        publisher({
          type: "approval_resolved",
          approvalId: approval.id,
          decision: "denied",
        });
        resolve({ approved: false, approval });
      }, timeoutMs);
      timer.unref();

      this.pending.set(approval.id, { approval, timer, resolve });
      publisher({ type: "approval_required", approval });
    });
  }

  resolve(sessionId: string, approvalId: string, approved: boolean): ApprovalRequest | undefined {
    const pending = this.pending.get(approvalId);
    if (!pending || pending.approval.sessionId !== sessionId) {
      return undefined;
    }

    clearTimeout(pending.timer);
    this.pending.delete(approvalId);
    const publisher = this.publishers.get(sessionId);
    publisher?.({
      type: "approval_resolved",
      approvalId,
      decision: approved ? "approved" : "denied",
    });
    pending.resolve({ approved, approval: pending.approval });
    return pending.approval;
  }

  cancelSession(sessionId: string): void {
    for (const [approvalId, pending] of this.pending) {
      if (pending.approval.sessionId === sessionId) {
        clearTimeout(pending.timer);
        this.pending.delete(approvalId);
        pending.resolve({ approved: false, approval: pending.approval });
      }
    }
  }
}
