/**
 * DigestPipeline Pipeline — Shared Types
 * Agent: eng-ai + eng-backend
 */

export type DigestPipelineStatus = "PENDING" | "APPROVED" | "EXPIRED" | "SENT" | "FAILED";

export type SectionName =
  | "what_shipped"
  | "whats_coming"
  | "new_joiners"
  | "wins_recognition"
  | "the_ask";

export interface SourceItem {
  id: string;
  source: "github" | "linear" | "notion" | "slack";
  section: SectionName;
  title: string;
  description?: string;
  url?: string;
  author?: ResolvedIdentity;
  publishedAt: Date;
  rawSignals: Record<string, unknown>;
}

declare const sanitizedBrand: unique symbol;
// Branded type: aggregators must run items through `sanitizeSourceItem`
// before they leave the source boundary. The prompt builder accepts
// only this type, so the type system enforces "PII-filtered" before
// any item reaches the LLM.
export type SanitizedSourceItem = SourceItem & { readonly [sanitizedBrand]: true };

export interface ResolvedIdentity {
  userId: string;
  displayName: string;
  role: string;
  team: string;
}

export interface RankedSection {
  name: SectionName;
  displayName: string;
  items: SanitizedSourceItem[]; // max 5, ranked by significance
  truncatedCount: number;
}

export interface Draft {
  id: string;
  runId: string; // correlation ID
  weekOf: Date;
  status: DigestPipelineStatus;
  sections: RankedSection[];
  fullText: string;
  createdAt: Date;
  approvedBy?: string;
  approvedAt?: Date;
  sentAt?: Date;
}

export type AuditEventType =
  | "DRAFT_GENERATED"
  | "HUMAN_EDIT"
  | "APPROVED"
  | "SENT"
  | "EXPIRED"
  | "SOURCE_FAILURE"
  | "PIPELINE_FAILURE";

export interface AuditEvent {
  id: string;
  runId: string;
  eventType: AuditEventType;
  actor: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface PipelineConfig {
  slackReviewChannelId: string;
  backupApproverIds: string[];
  voiceBaselineBucket: string;
  rawAggregationsBucket: string;
  llm: {
    modelId: string;
    region: string;
    maxTokens: number;
    temperature: number;
  };
  schedule: {
    timezone: "America/Los_Angeles";
    dayOfWeek: "Friday";
    draftPostHour: 9;
    draftPostMinute: 45;
    reminderHour: 11;
    expiryHour: 12;
  };
}

export interface AggregationResult {
  source: string;
  items: SanitizedSourceItem[];
  error?: string;
  durationMs: number;
}

export interface PipelineRunResult {
  runId: string;
  weekOf: Date;
  draftId?: string;
  status: "SUCCESS" | "PARTIAL" | "FAILED";
  sourceResults: AggregationResult[];
  durationMs: number;
  error?: string;
}
