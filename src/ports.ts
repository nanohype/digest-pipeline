/**
 * Application ports — the abstract interfaces the delivery layer (the
 * Fastify API) and the infrastructure layer (the Postgres adapters, the
 * SES sender, the Slack confirmer) both depend on. Concretes are wired at
 * the composition root (src/api/entrypoint.ts).
 *
 * Keeping the ports here, rather than inside the API server module, keeps
 * the dependency arrow pointing inward: a persistence adapter implements a
 * port without importing the web framework just to reach a type.
 */

import type { Draft } from './pipeline/types.js';

export interface NewDraftInput {
  runId: string;
  weekOf: Date;
  sections: Draft['sections'];
  fullText: string;
}

export interface DraftRepository {
  create(input: NewDraftInput): Promise<string>;
  findById(id: string): Promise<Draft | null>;
  saveEditCheckpoint(id: string, editedText: string, editorUserId: string): Promise<void>;
  approve(id: string, approverUserId: string): Promise<void>;
  markSent(id: string): Promise<void>;
}

export interface EditStats {
  distanceChars: number;
  editRate: number;
}

export interface AuditWriterPort {
  humanEdit(
    runId: string,
    draftId: string,
    editorUserId: string,
    originalText: string,
    editedText: string,
  ): Promise<EditStats>;
  approved(runId: string, draftId: string, approverUserId: string): Promise<void>;
  sent(runId: string, draftId: string, sesMessageId: string, recipientCount: number): Promise<void>;
}

export interface EmailSender {
  send(input: {
    draftId: string;
    subject: string;
    htmlBody: string;
    textBody: string;
  }): Promise<{ messageId: string; recipientCount: number }>;
}

export interface SlackConfirmer {
  confirmSent(runId: string, draftId: string, recipientCount: number): Promise<void>;
}
