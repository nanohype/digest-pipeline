/**
 * Postgres-backed DraftRepository.
 *
 * Every write is parameterised (never string-concatenated). Status
 * transitions go through guarded UPDATE statements that check the current
 * status in the WHERE clause so a racing approve/expire doesn't double-send.
 */

import type { Pool } from 'pg';
import type { Draft, DispatchStatus, RankedSection } from '../pipeline/types.js';
import type { DraftRepository } from '../api/server.js';

interface DraftRow {
  id: string;
  run_id: string;
  week_of: Date;
  status: DispatchStatus;
  sections: RankedSection[];
  full_text: string;
  edited_text: string | null;
  created_at: Date;
  approved_by: string | null;
  approved_at: Date | null;
  sent_at: Date | null;
  ses_message_id: string | null;
}

function rowToDraft(row: DraftRow): Draft {
  return {
    id: row.id,
    runId: row.run_id,
    weekOf: row.week_of,
    status: row.status,
    sections: row.sections,
    fullText: row.edited_text ?? row.full_text,
    createdAt: row.created_at,
    approvedBy: row.approved_by ?? undefined,
    approvedAt: row.approved_at ?? undefined,
    sentAt: row.sent_at ?? undefined,
  };
}

export function createPostgresDraftRepository(pool: Pool): DraftRepository {
  return {
    async create({ runId, weekOf, sections, fullText }) {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO drafts (run_id, week_of, status, sections, full_text)
         VALUES ($1, $2, 'PENDING', $3::jsonb, $4)
         RETURNING id`,
        [runId, weekOf, JSON.stringify(sections), fullText]
      );
      return rows[0].id;
    },

    async findById(id) {
      const { rows } = await pool.query<DraftRow>(
        `SELECT id, run_id, week_of, status, sections, full_text, edited_text,
                created_at, approved_by, approved_at, sent_at, ses_message_id
         FROM drafts
         WHERE id = $1`,
        [id]
      );
      const row = rows[0];
      return row ? rowToDraft(row) : null;
    },

    async saveEditCheckpoint(id, editedText, _editorUserId) {
      await pool.query(
        `UPDATE drafts
         SET edited_text = $2,
             updated_at = NOW()
         WHERE id = $1 AND status = 'PENDING'`,
        [id, editedText]
      );
    },

    async approve(id, approverUserId) {
      const result = await pool.query(
        `UPDATE drafts
         SET status = 'APPROVED',
             approved_by = $2,
             approved_at = NOW(),
             updated_at = NOW()
         WHERE id = $1 AND status = 'PENDING'`,
        [id, approverUserId]
      );
      if (result.rowCount === 0) {
        throw new Error(`Draft ${id} could not be approved (not PENDING)`);
      }
    },

    async markSent(id) {
      await pool.query(
        `UPDATE drafts
         SET status = 'SENT',
             sent_at = NOW(),
             updated_at = NOW()
         WHERE id = $1 AND status IN ('APPROVED', 'PENDING')`,
        [id]
      );
    },
  };
}
