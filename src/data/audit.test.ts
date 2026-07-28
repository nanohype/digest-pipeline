/**
 * Postgres audit-ledger tests.
 *
 * The Pool is injected, so the real SQL these functions emit is assertable
 * without a database and without mocking `pg` itself. What matters here is the
 * shape of what reaches the table: an audit row nobody can attribute is not an
 * audit row, and `sent` has to write two of them.
 *
 * Zero coverage before this, on the write path behind a human-approval gate.
 */

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createPostgresAuditDatabase, createPostgresAuditWriter } from "./audit.js";

function fakePool() {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  return { pool: { query } as unknown as Pool, query };
}

const sql = (query: ReturnType<typeof vi.fn>, call = 0) =>
  String(query.mock.calls[call][0]).replace(/\s+/g, " ").trim();
const params = (query: ReturnType<typeof vi.fn>, call = 0) => query.mock.calls[call][1];

describe("createPostgresAuditDatabase", () => {
  it("inserts the event with its own createdAt rather than a database default", async () => {
    // The pipeline-side writer stamps createdAt so the recorded time is when the
    // event happened, not when the row landed.
    const { pool, query } = fakePool();
    const createdAt = new Date("2026-04-10T12:00:00Z");
    await createPostgresAuditDatabase(pool).insertAuditEvent({
      runId: "run-1",
      eventType: "APPROVED",
      actor: "U1",
      payload: { draftId: "d1" },
      createdAt,
    });
    expect(sql(query)).toContain("INSERT INTO audit_events");
    expect(sql(query)).toContain("created_at");
    expect(params(query)).toEqual(["run-1", "APPROVED", "U1", { draftId: "d1" }, createdAt]);
  });

  it("rejects when the insert fails", async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error("deadlock detected")) };
    await expect(
      createPostgresAuditDatabase(pool as unknown as Pool).insertAuditEvent({
        runId: "r",
        eventType: "SENT",
        actor: "system",
        payload: {},
        createdAt: new Date(),
      }),
    ).rejects.toThrow(/deadlock/);
  });
});

describe("createPostgresAuditWriter.humanEdit", () => {
  it("writes the edit metrics and returns the raw distance and rate", async () => {
    const { pool, query } = fakePool();
    const out = await createPostgresAuditWriter(pool).humanEdit(
      "run-1",
      "d1",
      "U1",
      "abcd",
      "abcx",
    );
    expect(params(query)).toEqual([
      "run-1",
      "HUMAN_EDIT",
      "U1",
      {
        draftId: "d1",
        editDistanceChars: 1,
        editRate: 25,
        originalLength: 4,
        editedLength: 4,
      },
    ]);
    // The stored payload is a rounded percentage; the return value is the raw
    // ratio. Both are used — the row for reporting, the return for the caller's
    // own threshold checks — so a change that conflated them would be silent.
    expect(out).toEqual({ distanceChars: 1, editRate: 0.25 });
  });

  it("does not divide by zero on an empty original", async () => {
    const { pool } = fakePool();
    const out = await createPostgresAuditWriter(pool).humanEdit("run-1", "d1", "U1", "", "added");
    expect(Number.isFinite(out.editRate)).toBe(true);
    expect(out).toEqual({ distanceChars: 5, editRate: 5 });
  });
});

describe("createPostgresAuditWriter.approved", () => {
  it("attributes the row to the approving human", async () => {
    const { pool, query } = fakePool();
    await createPostgresAuditWriter(pool).approved("run-1", "d1", "U-approver");
    expect(params(query)).toEqual(["run-1", "APPROVED", "U-approver", { draftId: "d1" }]);
  });

  it("rejects when the insert fails, so an unrecorded approval cannot proceed", async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error("read-only transaction")) };
    await expect(
      createPostgresAuditWriter(pool as unknown as Pool).approved("run-1", "d1", "U1"),
    ).rejects.toThrow(/read-only/);
  });
});

describe("createPostgresAuditWriter.sent", () => {
  it("writes both the audit row and the analytics row", async () => {
    const { pool, query } = fakePool();
    await createPostgresAuditWriter(pool).sent("run-1", "d1", "ses-99", 512);
    expect(query).toHaveBeenCalledTimes(2);
    expect(params(query, 0)).toEqual([
      "run-1",
      "SENT",
      "system",
      { draftId: "d1", sesMessageId: "ses-99", recipientCount: 512 },
    ]);
    expect(sql(query, 1)).toContain("INSERT INTO email_analytics");
    expect(params(query, 1)).toEqual(["d1", "ses-99"]);
  });

  it("makes the analytics insert idempotent on the SES message id", async () => {
    // A resend or a replayed webhook must not duplicate the analytics row, and
    // must not fail the send path either.
    const { pool, query } = fakePool();
    await createPostgresAuditWriter(pool).sent("run-1", "d1", "ses-99", 1);
    expect(sql(query, 1)).toContain("ON CONFLICT (ses_message_id) DO NOTHING");
  });

  it("rejects when the audit row fails, before the analytics row is attempted", async () => {
    const query = vi.fn().mockRejectedValueOnce(new Error("disk full"));
    await expect(
      createPostgresAuditWriter({ query } as unknown as Pool).sent("run-1", "d1", "ses-99", 1),
    ).rejects.toThrow(/disk full/);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
