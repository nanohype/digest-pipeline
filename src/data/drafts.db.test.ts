/**
 * The draft status machine, against a real Postgres.
 *
 * `drafts.test.ts` asserts the SQL this repository sends. This asserts what
 * Postgres does with it, and the two are not the same claim. The guards here are
 * conditional UPDATEs and CHECK constraints — they live in the engine, so a fake
 * pool can only confirm that the right statement was composed, never that the
 * database enforces it. The distinction matters most for the one property the
 * whole approval gate rests on: two approvals racing for the same row, where
 * exactly one must win. That has no meaning without a real transaction.
 *
 * The schema is applied from `migrations/*.up.sql` rather than from a fixture,
 * so the constraints under test are the ones that ship. A CHECK that was never
 * written, or written wrong, fails here rather than in production.
 *
 * `TEST_DATABASE_URL` unset skips the suite; set means it must run. A broken
 * database is a hard failure, never a silent skip — the same contract `EVAL_LLM`
 * carries in the eval tier, and for the same reason: a suite that quietly skips
 * converts an absence of evidence into a claim of safety.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RankedSection } from "../pipeline/types.js";
import { AuditWriter } from "../pipeline/audit.js";
import { createPostgresAuditDatabase, createPostgresAuditWriter } from "./audit.js";
import { createPostgresDraftRepository } from "./drafts.js";
import { createDbPool } from "./pool.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;

const WEEK_OF = new Date("2026-04-10T00:00:00Z");
const PRIOR_WEEK = new Date("2026-04-03T00:00:00Z");
const SECTIONS = [
  { name: "what_shipped", displayName: "What Shipped", items: [], truncatedCount: 0 },
] as unknown as RankedSection[];

describe.skipIf(!DATABASE_URL)("draft status machine (real Postgres)", () => {
  let pool: Pool;
  let repo: ReturnType<typeof createPostgresDraftRepository>;
  /** The pipeline's ledger writer — appends to audit_events. */
  let ledger: AuditWriter;
  /** The api's writer — also lands the email_analytics row on send. */
  let apiAudit: ReturnType<typeof createPostgresAuditWriter>;

  beforeAll(async () => {
    // Not wrapped in try/catch: if the database is unreachable this must fail
    // the run rather than degrade into a skip.
    pool = createDbPool(DATABASE_URL as string);
    const dir = resolve(import.meta.dirname, "..", "..", "migrations");
    const ups = readdirSync(dir)
      .filter((f) => f.endsWith(".up.sql"))
      .sort();
    if (ups.length === 0) throw new Error(`no .up.sql migrations found in ${dir}`);
    for (const file of ups) {
      await pool.query(readFileSync(resolve(dir, file), "utf8"));
    }
    repo = createPostgresDraftRepository(pool);
    ledger = new AuditWriter(createPostgresAuditDatabase(pool));
    apiAudit = createPostgresAuditWriter(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    // email_analytics references drafts, so CASCADE keeps the order irrelevant.
    await pool.query("TRUNCATE drafts, audit_events, email_analytics CASCADE");
  });

  /** A PENDING draft for `weekOf`, returning its id. */
  async function newDraft(weekOf = WEEK_OF): Promise<string> {
    return repo.create({ runId: crypto.randomUUID(), weekOf, sections: SECTIONS, fullText: "x" });
  }

  async function statusOf(id: string): Promise<string> {
    const { rows } = await pool.query<{ status: string }>(
      "SELECT status FROM drafts WHERE id = $1",
      [id],
    );
    return rows[0].status;
  }

  describe("the double-send guard", () => {
    /**
     * The reason this file exists. The API checks the status before calling
     * `approve`, but that read and this write are not one transaction — two
     * approvals racing both pass the check, and only the conditional UPDATE
     * decides. Against a fake pool this is unprovable: the fake returns whatever
     * rowCount it was told to.
     */
    it("lets exactly one of two concurrent approvals win", async () => {
      const id = await newDraft();

      const results = await Promise.allSettled([
        repo.approve(id, "user_cos"),
        repo.approve(id, "user_backup"),
      ]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(rejected).toHaveLength(1);
      expect(String(rejected[0].reason)).toMatch(/not PENDING/);
      expect(await statusOf(id)).toBe("APPROVED");
    });

    it("records only one approver, not the last writer", async () => {
      const id = await newDraft();
      await Promise.allSettled([repo.approve(id, "user_cos"), repo.approve(id, "user_backup")]);

      const { rows } = await pool.query<{ approved_by: string }>(
        "SELECT approved_by FROM drafts WHERE id = $1",
        [id],
      );
      expect(["user_cos", "user_backup"]).toContain(rows[0].approved_by);
    });

    it("refuses a second approval attempted after the first settled", async () => {
      const id = await newDraft();
      await repo.approve(id, "user_cos");

      await expect(repo.approve(id, "user_backup")).rejects.toThrow(/not PENDING/);
    });
  });

  describe("send", () => {
    it("marks an APPROVED draft sent", async () => {
      const id = await newDraft();
      await repo.approve(id, "user_cos");
      await repo.markSent(id);

      expect(await statusOf(id)).toBe("SENT");
    });

    it("refuses to send a draft that never passed the approval gate", async () => {
      const id = await newDraft();
      await expect(repo.markSent(id)).rejects.toThrow(/not APPROVED/);
      expect(await statusOf(id)).toBe("PENDING");
    });

    it("refuses to send the same draft twice", async () => {
      const id = await newDraft();
      await repo.approve(id, "user_cos");
      await repo.markSent(id);

      await expect(repo.markSent(id)).rejects.toThrow(/not APPROVED/);
    });

    it("refuses to send an EXPIRED draft", async () => {
      const id = await newDraft(PRIOR_WEEK);
      await repo.expirePending(WEEK_OF);
      expect(await statusOf(id)).toBe("EXPIRED");

      await expect(repo.markSent(id)).rejects.toThrow(/not APPROVED/);
    });
  });

  describe("expiry", () => {
    it("expires a PENDING draft from an earlier week and returns it", async () => {
      const stale = await newDraft(PRIOR_WEEK);

      const expired = await repo.expirePending(WEEK_OF);

      expect(expired.map((e) => e.id)).toEqual([stale]);
      expect(await statusOf(stale)).toBe("EXPIRED");
    });

    it("leaves the current week's draft alone", async () => {
      const current = await newDraft(WEEK_OF);

      expect(await repo.expirePending(WEEK_OF)).toEqual([]);
      expect(await statusOf(current)).toBe("PENDING");
    });

    /** The status guard, against the race it exists for. */
    it("does not claw back a draft approved before the sweep ran", async () => {
      const id = await newDraft(PRIOR_WEEK);
      await repo.approve(id, "user_cos");

      expect(await repo.expirePending(WEEK_OF)).toEqual([]);
      expect(await statusOf(id)).toBe("APPROVED");
    });

    it("returns the run id each draft belongs to, which the audit is keyed on", async () => {
      const runId = crypto.randomUUID();
      const id = await repo.create({
        runId,
        weekOf: PRIOR_WEEK,
        sections: SECTIONS,
        fullText: "x",
      });

      expect(await repo.expirePending(WEEK_OF)).toEqual([{ id, runId }]);
    });

    it("cannot be approved once expired", async () => {
      const id = await newDraft(PRIOR_WEEK);
      await repo.expirePending(WEEK_OF);

      await expect(repo.approve(id, "user_cos")).rejects.toThrow(/not PENDING/);
    });
  });

  describe("the constraints themselves", () => {
    /**
     * These assert the migration, not the repository. The status machine is only
     * as good as the CHECK behind it: without this, a future migration could
     * widen the allowed set and every test above would still pass.
     */
    it("rejects a status outside the declared set", async () => {
      const id = await newDraft();
      await expect(
        pool.query("UPDATE drafts SET status = 'ALMOST_SENT' WHERE id = $1", [id]),
      ).rejects.toThrow(/violates check constraint/);
    });

    it("rejects an audit event type outside the declared set", async () => {
      await expect(
        pool.query(
          `INSERT INTO audit_events (run_id, event_type, actor, payload)
           VALUES ($1, 'ALMOST_APPROVED', 'system', '{}'::jsonb)`,
          [crypto.randomUUID()],
        ),
      ).rejects.toThrow(/violates check constraint/);
    });

    it("keeps email_analytics idempotent per SES message id", async () => {
      const runId = crypto.randomUUID();
      const id = await repo.create({
        runId,
        weekOf: WEEK_OF,
        sections: SECTIONS,
        fullText: "x",
      });

      // Deliberately the api writer: `createPostgresAuditDatabase` is the
      // low-level DatabaseClient behind the pipeline's ledger and writes only
      // audit_events. The email_analytics row belongs to the api's
      // AuditWriterPort, which is the path a real send takes.
      await apiAudit.sent(runId, id, "ses-message-1", 500);
      await apiAudit.sent(runId, id, "ses-message-1", 500);

      const { rows } = await pool.query<{ count: string }>(
        "SELECT count(*) FROM email_analytics WHERE ses_message_id = $1",
        ["ses-message-1"],
      );
      expect(rows[0].count).toBe("1");
    });
  });

  describe("the audit ledger", () => {
    it("appends every event under the run it belongs to", async () => {
      const runId = crypto.randomUUID();
      const id = await repo.create({
        runId,
        weekOf: WEEK_OF,
        sections: SECTIONS,
        fullText: "x",
      });

      await repo.approve(id, "user_cos");
      await ledger.approved(runId, id, "user_cos");
      await ledger.expired(runId, id);

      const { rows } = await pool.query<{ event_type: string; actor: string }>(
        "SELECT event_type, actor FROM audit_events WHERE run_id = $1 ORDER BY created_at ASC",
        [runId],
      );
      expect(rows.map((r) => r.event_type)).toEqual(["APPROVED", "EXPIRED"]);
      expect(rows.map((r) => r.actor)).toEqual(["user_cos", "system"]);
    });
  });
});
