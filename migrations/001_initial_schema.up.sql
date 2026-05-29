-- Initial schema for dispatch.
--
-- drafts holds every weekly newsletter: one row per pipeline run.
-- audit_events is an append-only log; every write (generation, edit,
-- approval, send, expiry) goes here with a correlating run_id. edit
-- rate is derived from HUMAN_EDIT events, never recomputed from current
-- draft text.
-- email_analytics stores SES feedback (opens, clicks) once SES
-- webhooks are wired.

CREATE TABLE IF NOT EXISTS drafts (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         UUID         NOT NULL,
  week_of        TIMESTAMPTZ  NOT NULL,
  status         TEXT         NOT NULL
                 CHECK (status IN ('PENDING', 'APPROVED', 'EXPIRED', 'SENT', 'FAILED')),
  sections       JSONB        NOT NULL,
  full_text      TEXT         NOT NULL,
  edited_text    TEXT         NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  approved_by    TEXT         NULL,
  approved_at    TIMESTAMPTZ  NULL,
  sent_at        TIMESTAMPTZ  NULL,
  ses_message_id TEXT         NULL,
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS drafts_run_id_idx ON drafts (run_id);
CREATE INDEX IF NOT EXISTS drafts_status_idx ON drafts (status);
CREATE INDEX IF NOT EXISTS drafts_week_of_idx ON drafts (week_of DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id     UUID         NOT NULL,
  event_type TEXT         NOT NULL
             CHECK (event_type IN (
               'DRAFT_GENERATED',
               'HUMAN_EDIT',
               'APPROVED',
               'SENT',
               'EXPIRED',
               'SOURCE_FAILURE',
               'PIPELINE_FAILURE'
             )),
  actor      TEXT         NOT NULL,
  payload    JSONB        NOT NULL,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_events_run_id_idx ON audit_events (run_id);
CREATE INDEX IF NOT EXISTS audit_events_event_type_idx ON audit_events (event_type);
CREATE INDEX IF NOT EXISTS audit_events_created_at_idx ON audit_events (created_at DESC);

CREATE TABLE IF NOT EXISTS email_analytics (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id       UUID         NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  ses_message_id TEXT         NOT NULL,
  opens          INTEGER      NOT NULL DEFAULT 0,
  clicks         INTEGER      NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS email_analytics_ses_message_id_idx
  ON email_analytics (ses_message_id);
