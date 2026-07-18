/**
 * Audit Trail — every draft_generated, human_edit, and send event awaited
 * Agent: eng-backend
 *
 * All writes are awaited — pipeline does not advance until confirmed.
 * Correlation ID (runId) required on every event.
 */

import { levenshteinDistance } from "../common/string.js";
import type { AuditEvent, AuditEventType } from "./types.js";

export interface DatabaseClient {
  insertAuditEvent(event: Omit<AuditEvent, "id">): Promise<void>;
}

export class AuditWriter {
  private db: DatabaseClient;
  constructor(db: DatabaseClient) {
    this.db = db;
  }

  async write(
    runId: string,
    eventType: AuditEventType,
    actor: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.db.insertAuditEvent({ runId, eventType, actor, payload, createdAt: new Date() });
  }

  async draftGenerated(
    runId: string,
    draftId: string,
    sourceResults: Array<{ source: string; itemCount: number; error?: string }>,
    llmTokensUsed: number,
  ): Promise<void> {
    await this.write(runId, "DRAFT_GENERATED", "system", { draftId, sourceResults, llmTokensUsed });
  }

  async humanEdit(
    runId: string,
    draftId: string,
    editorUserId: string,
    originalText: string,
    editedText: string,
  ): Promise<void> {
    const editDistance = levenshteinDistance(originalText, editedText);
    const editRate = editDistance / Math.max(originalText.length, 1);
    await this.write(runId, "HUMAN_EDIT", editorUserId, {
      draftId,
      editDistanceChars: editDistance,
      editRate: Math.round(editRate * 10000) / 100,
      originalLength: originalText.length,
      editedLength: editedText.length,
    });
  }

  async approved(runId: string, draftId: string, approverUserId: string): Promise<void> {
    await this.write(runId, "APPROVED", approverUserId, { draftId });
  }

  async sent(
    runId: string,
    draftId: string,
    sesMessageId: string,
    recipientCount: number,
  ): Promise<void> {
    await this.write(runId, "SENT", "system", { draftId, sesMessageId, recipientCount });
  }

  async expired(runId: string, draftId: string): Promise<void> {
    await this.write(runId, "EXPIRED", "system", { draftId });
  }
}
