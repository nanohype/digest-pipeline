/**
 * Audit ledger tests.
 *
 * This file's header claims "All writes are awaited — pipeline does not advance
 * until confirmed." That is a compliance property, not a style note: an audit
 * event that fails silently means an approval or a send with no record. So each
 * method is tested twice — once for the event it writes, once to prove a failing
 * database surfaces as a rejection rather than being swallowed.
 *
 * The ledger had zero coverage before this, on a repo whose product is a
 * human-approval gate.
 */

import { describe, expect, it, vi } from "vitest";
import { AuditWriter, type DatabaseClient } from "./audit.js";

function fakeDb() {
  const insertAuditEvent = vi.fn().mockResolvedValue(undefined);
  return { db: { insertAuditEvent } as DatabaseClient, insertAuditEvent };
}

function failingDb(message = "connection terminated") {
  return {
    insertAuditEvent: vi.fn().mockRejectedValue(new Error(message)),
  } as unknown as DatabaseClient;
}

describe("AuditWriter.write", () => {
  it("stamps runId, type, actor, payload and a createdAt on every event", async () => {
    const { db, insertAuditEvent } = fakeDb();
    await new AuditWriter(db).write("run-1", "APPROVED", "U1", { draftId: "d1" });
    expect(insertAuditEvent).toHaveBeenCalledTimes(1);
    const event = insertAuditEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      runId: "run-1",
      eventType: "APPROVED",
      actor: "U1",
      payload: { draftId: "d1" },
    });
    expect(event.createdAt).toBeInstanceOf(Date);
  });

  it("rejects when the insert fails, so the caller cannot advance", async () => {
    await expect(new AuditWriter(failingDb()).write("run-1", "APPROVED", "U1", {})).rejects.toThrow(
      /connection terminated/,
    );
  });
});

describe("AuditWriter event shapes", () => {
  it("draftGenerated records the per-source results and token spend", async () => {
    const { db, insertAuditEvent } = fakeDb();
    const sources = [
      { source: "github", itemCount: 4 },
      { source: "linear", itemCount: 0, error: "timeout" },
    ];
    await new AuditWriter(db).draftGenerated("run-1", "d1", sources, 1234);
    expect(insertAuditEvent.mock.calls[0][0]).toMatchObject({
      eventType: "DRAFT_GENERATED",
      actor: "system",
      payload: { draftId: "d1", sourceResults: sources, llmTokensUsed: 1234 },
    });
  });

  it("approved attributes the event to the approving human, not the system", async () => {
    const { db, insertAuditEvent } = fakeDb();
    await new AuditWriter(db).approved("run-1", "d1", "U-approver");
    expect(insertAuditEvent.mock.calls[0][0]).toMatchObject({
      eventType: "APPROVED",
      actor: "U-approver",
      payload: { draftId: "d1" },
    });
  });

  it("sent records the SES message id and recipient count", async () => {
    const { db, insertAuditEvent } = fakeDb();
    await new AuditWriter(db).sent("run-1", "d1", "ses-99", 512);
    expect(insertAuditEvent.mock.calls[0][0]).toMatchObject({
      eventType: "SENT",
      actor: "system",
      payload: { draftId: "d1", sesMessageId: "ses-99", recipientCount: 512 },
    });
  });

  it("expired records the draft that timed out", async () => {
    const { db, insertAuditEvent } = fakeDb();
    await new AuditWriter(db).expired("run-1", "d1");
    expect(insertAuditEvent.mock.calls[0][0]).toMatchObject({
      eventType: "EXPIRED",
      actor: "system",
      payload: { draftId: "d1" },
    });
  });
});

describe("AuditWriter.humanEdit", () => {
  it("records the edit distance and the rate as a percentage", async () => {
    const { db, insertAuditEvent } = fakeDb();
    // "abcd" -> "abcx": one substitution over four characters = 25%.
    await new AuditWriter(db).humanEdit("run-1", "d1", "U1", "abcd", "abcx");
    expect(insertAuditEvent.mock.calls[0][0].payload).toEqual({
      draftId: "d1",
      editDistanceChars: 1,
      editRate: 25,
      originalLength: 4,
      editedLength: 4,
    });
  });

  it("reports a zero rate when the human changed nothing", async () => {
    const { db, insertAuditEvent } = fakeDb();
    await new AuditWriter(db).humanEdit("run-1", "d1", "U1", "same text", "same text");
    expect(insertAuditEvent.mock.calls[0][0].payload).toMatchObject({
      editDistanceChars: 0,
      editRate: 0,
    });
  });

  it("does not divide by zero when the original draft was empty", async () => {
    // Math.max(length, 1) is the guard. Without it an empty original yields
    // Infinity, which serialises into the ledger as null and loses the event's
    // only quantitative field.
    const { db, insertAuditEvent } = fakeDb();
    await new AuditWriter(db).humanEdit("run-1", "d1", "U1", "", "added");
    const payload = insertAuditEvent.mock.calls[0][0].payload;
    expect(payload.editDistanceChars).toBe(5);
    expect(Number.isFinite(payload.editRate)).toBe(true);
    expect(payload.editRate).toBe(500);
  });

  it("rejects when the insert fails", async () => {
    await expect(
      new AuditWriter(failingDb()).humanEdit("run-1", "d1", "U1", "a", "b"),
    ).rejects.toThrow();
  });
});
