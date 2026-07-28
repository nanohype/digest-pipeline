/**
 * Postgres DraftRepository tests.
 *
 * The status machine lives in SQL, not in TypeScript — `approve` and
 * `markSent` carry their precondition in the WHERE clause so two concurrent
 * approvals cannot both win. That makes the WHERE clause the guard's only
 * expression, so these tests assert on it directly: a test that only checked
 * the rowCount handling would stay green if someone dropped
 * `AND status = 'PENDING'`, which is the exact edit that allows a double-send.
 *
 * The query layer is faked; the SQL and the row mapping are real.
 */

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { RankedSection } from "../pipeline/types.js";
import { createPostgresDraftRepository } from "./drafts.js";

/** Collapse newlines + runs of spaces so assertions read like the statement. */
function sql(call: unknown[]): string {
  return String(call[0]).replace(/\s+/g, " ").trim();
}

function fakePool(result: { rows?: unknown[]; rowCount?: number } = {}) {
  const query = vi.fn(async (_statement: string, _params?: unknown[]) => ({
    rows: result.rows ?? [],
    rowCount: result.rowCount ?? 0,
  }));
  return { pool: { query } as unknown as Pool, query };
}

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";

function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DRAFT_ID,
    run_id: "run_1",
    week_of: new Date("2026-04-10T00:00:00Z"),
    status: "PENDING",
    sections: [] as RankedSection[],
    full_text: "the generated draft",
    edited_text: null,
    created_at: new Date("2026-04-10T09:00:00Z"),
    approved_by: null,
    approved_at: null,
    sent_at: null,
    ses_message_id: null,
    ...overrides,
  };
}

describe("create", () => {
  it("returns the new id and passes every value as a bound parameter", async () => {
    const { pool, query } = fakePool({ rows: [{ id: DRAFT_ID }] });
    const sections = [
      { name: "what_shipped", displayName: "What Shipped", items: [], truncatedCount: 0 },
    ] as unknown as RankedSection[];

    const id = await createPostgresDraftRepository(pool).create({
      runId: "run_1",
      weekOf: new Date("2026-04-10T00:00:00Z"),
      sections,
      fullText: "the generated draft",
    });

    expect(id).toBe(DRAFT_ID);
    const [statement, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    // Draft text is model output built from Slack, GitHub, Linear and Notion
    // strings. It reaches the database as a parameter or not at all.
    expect(statement).not.toContain("the generated draft");
    expect(params).toEqual([
      "run_1",
      new Date("2026-04-10T00:00:00Z"),
      JSON.stringify(sections),
      "the generated draft",
    ]);
  });

  it("opens the draft in PENDING so the approval gate is the only way out", async () => {
    const { pool, query } = fakePool({ rows: [{ id: DRAFT_ID }] });
    await createPostgresDraftRepository(pool).create({
      runId: "run_1",
      weekOf: new Date(),
      sections: [],
      fullText: "x",
    });
    expect(sql(query.mock.calls[0])).toContain("VALUES ($1, $2, 'PENDING', $3::jsonb, $4)");
  });
});

describe("findById", () => {
  it("maps a row onto the Draft shape", async () => {
    const { pool } = fakePool({ rows: [draftRow()] });
    const draft = await createPostgresDraftRepository(pool).findById(DRAFT_ID);

    expect(draft).toMatchObject({
      id: DRAFT_ID,
      runId: "run_1",
      status: "PENDING",
      fullText: "the generated draft",
    });
  });

  it("serves the human's edit in place of the generated text once one exists", async () => {
    // Everything downstream — the approve route's SES body, the edit-distance
    // baseline — reads `fullText`. If the raw model output kept winning here,
    // approving an edited draft would mail the unedited one.
    const { pool } = fakePool({ rows: [draftRow({ edited_text: "the human's rewrite" })] });
    const draft = await createPostgresDraftRepository(pool).findById(DRAFT_ID);

    expect(draft?.fullText).toBe("the human's rewrite");
  });

  it("normalises the nullable columns to undefined", async () => {
    const { pool } = fakePool({ rows: [draftRow()] });
    const draft = await createPostgresDraftRepository(pool).findById(DRAFT_ID);

    expect(draft?.approvedBy).toBeUndefined();
    expect(draft?.approvedAt).toBeUndefined();
    expect(draft?.sentAt).toBeUndefined();
  });

  it("carries the approval and send stamps through when they are set", async () => {
    const { pool } = fakePool({
      rows: [
        draftRow({
          status: "SENT",
          approved_by: "user_cos",
          approved_at: new Date("2026-04-10T10:30:00Z"),
          sent_at: new Date("2026-04-10T10:31:00Z"),
        }),
      ],
    });
    const draft = await createPostgresDraftRepository(pool).findById(DRAFT_ID);

    expect(draft).toMatchObject({
      status: "SENT",
      approvedBy: "user_cos",
      approvedAt: new Date("2026-04-10T10:30:00Z"),
      sentAt: new Date("2026-04-10T10:31:00Z"),
    });
  });

  it("returns null for an unknown id rather than throwing", async () => {
    const { pool } = fakePool({ rows: [] });
    expect(await createPostgresDraftRepository(pool).findById("nope")).toBeNull();
  });
});

describe("saveEditCheckpoint", () => {
  it("only writes while the draft is still PENDING", async () => {
    const { pool, query } = fakePool();
    await createPostgresDraftRepository(pool).saveEditCheckpoint(DRAFT_ID, "revised", "user_cos");

    expect(sql(query.mock.calls[0])).toContain("WHERE id = $1 AND status = 'PENDING'");
    expect(query.mock.calls[0][1]).toEqual([DRAFT_ID, "revised"]);
  });
});

describe("approve", () => {
  it("transitions only from PENDING, stamping the approver", async () => {
    const { pool, query } = fakePool({ rowCount: 1 });
    await createPostgresDraftRepository(pool).approve(DRAFT_ID, "user_cos");

    const statement = sql(query.mock.calls[0]);
    expect(statement).toContain("SET status = 'APPROVED'");
    expect(statement).toContain("WHERE id = $1 AND status = 'PENDING'");
    expect(query.mock.calls[0][1]).toEqual([DRAFT_ID, "user_cos"]);
  });

  it("throws when the guard matched nothing, so a second approval cannot send", async () => {
    // This is the double-send guard. The API checks the status before calling,
    // but that check and this write are not one transaction — two approvals
    // racing both pass the check, and only this rowCount tells the loser.
    const { pool } = fakePool({ rowCount: 0 });
    await expect(createPostgresDraftRepository(pool).approve(DRAFT_ID, "user_cos")).rejects.toThrow(
      /could not be approved \(not PENDING\)/,
    );
  });
});

describe("markSent", () => {
  it("accepts APPROVED or PENDING and refuses anything else", async () => {
    const { pool, query } = fakePool({ rowCount: 1 });
    await createPostgresDraftRepository(pool).markSent(DRAFT_ID);

    const statement = sql(query.mock.calls[0]);
    expect(statement).toContain("SET status = 'SENT'");
    expect(statement).toContain("WHERE id = $1 AND status IN ('APPROVED', 'PENDING')");
  });
});
