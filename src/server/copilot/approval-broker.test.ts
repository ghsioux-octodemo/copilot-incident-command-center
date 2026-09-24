import { describe, expect, it, vi } from "vitest";

import { ApprovalBroker } from "./approval-broker.js";

describe("ApprovalBroker", () => {
  it("holds a mutation until the exact browser session approves it", async () => {
    const broker = new ApprovalBroker();
    const publisher = vi.fn();
    broker.attachPublisher("session-a", publisher);

    const pending = broker.request(
      "session-a",
      "assign_incident",
      "Assign INC-1042 to Maya Patel",
      { incidentId: "INC-1042", assignee: "Maya Patel" },
    );
    const approval = publisher.mock.calls[0][0].approval;

    expect(broker.resolve("session-b", approval.id, true)).toBeUndefined();
    expect(broker.resolve("session-a", approval.id, true)).toEqual(approval);
    await expect(pending).resolves.toEqual({ approved: true, approval });
  });

  it("fails closed when no browser stream is attached", async () => {
    const broker = new ApprovalBroker();

    await expect(
      broker.request("missing-session", "update_incident_status", "Change status", {
        incidentId: "INC-1042",
        status: "Investigating",
      }),
    ).resolves.toMatchObject({ approved: false });
  });
});
