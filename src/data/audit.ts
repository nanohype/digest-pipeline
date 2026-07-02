/**
 * Postgres-backed AuditWriterPort + pipeline-side AuditWriter database shim.
 *
 * The API-side port (AuditWriterPort in src/api/server.ts) deliberately
 * narrows the pipeline-side AuditWriter surface to the three events the
 * HTTP handlers emit (humanEdit, approved, sent). The pipeline's AuditWriter
 * uses the same underlying table via insertAuditEvent.
 */

import type { Pool } from 'pg';
import { levenshteinDistance } from '../common/string.js';
import type { AuditWriterPort } from '../ports.js';
import type { DatabaseClient } from '../pipeline/audit.js';

export function createPostgresAuditDatabase(pool: Pool): DatabaseClient {
  return {
    async insertAuditEvent(event) {
      await pool.query(
        `INSERT INTO audit_events (run_id, event_type, actor, payload, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [event.runId, event.eventType, event.actor, event.payload, event.createdAt],
      );
    },
  };
}

export function createPostgresAuditWriter(pool: Pool): AuditWriterPort {
  const insert = async (
    runId: string,
    eventType: string,
    actor: string,
    payload: Record<string, unknown>,
  ): Promise<void> => {
    await pool.query(
      `INSERT INTO audit_events (run_id, event_type, actor, payload)
       VALUES ($1, $2, $3, $4)`,
      [runId, eventType, actor, payload],
    );
  };

  return {
    async humanEdit(runId, draftId, editorUserId, originalText, editedText) {
      const distance = levenshteinDistance(originalText, editedText);
      const rate = distance / Math.max(originalText.length, 1);
      const editRatePct = Math.round(rate * 10000) / 100;
      await insert(runId, 'HUMAN_EDIT', editorUserId, {
        draftId,
        editDistanceChars: distance,
        editRate: editRatePct,
        originalLength: originalText.length,
        editedLength: editedText.length,
      });
      return { distanceChars: distance, editRate: rate };
    },

    async approved(runId, draftId, approverUserId) {
      await insert(runId, 'APPROVED', approverUserId, { draftId });
    },

    async sent(runId, draftId, sesMessageId, recipientCount) {
      await insert(runId, 'SENT', 'system', { draftId, sesMessageId, recipientCount });
      await pool.query(
        `INSERT INTO email_analytics (draft_id, ses_message_id)
         VALUES ($1, $2)
         ON CONFLICT (ses_message_id) DO NOTHING`,
        [draftId, sesMessageId],
      );
    },
  };
}
