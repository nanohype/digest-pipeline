/**
 * API server tests — the approve/send orchestrator is the security-critical
 * surface, so it gets behavior tests at the HTTP boundary via Fastify's
 * built-in app.inject() (no real sockets). Dependencies are injected as
 * fakes through ServerDeps, including a stub Authenticator so no real WorkOS
 * JWKS is hit. Mirrors the port-injection pattern used in generator.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildServer, type ServerDeps } from './server.js';
import type { Authenticator } from './auth.js';
import type { ApiConfig } from './config.js';
import type { Draft } from '../pipeline/types.js';

const DRAFT_ID = '11111111-1111-4111-8111-111111111111';
const COS_USER = 'user_cos';

function sampleDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    id: DRAFT_ID,
    runId: 'run_1',
    weekOf: new Date('2026-06-19T00:00:00Z'),
    status: 'PENDING',
    sections: [],
    fullText: 'Hello team, here is what shipped this week.',
    createdAt: new Date('2026-06-19T09:00:00Z'),
    ...overrides,
  };
}

function buildDeps(opts: { draft?: Draft; sub?: string } = {}): ServerDeps {
  const draft = opts.draft ?? sampleDraft();
  const config: ApiConfig = {
    env: {
      NODE_ENV: 'development',
      PORT: 3001,
      AWS_REGION: 'us-east-1',
      WORKOS_ISSUER: 'https://api.workos.com',
      WORKOS_CLIENT_ID: 'client_test',
      APPROVERS_SECRET_ID: 'approvers',
      WEB_ORIGIN: ['http://localhost:3000'],
    },
    secrets: {
      getJson: async () => {
        throw new Error('secrets are not used in these tests');
      },
    },
    loadApprovers: async () => ({ cosUserId: COS_USER, backupApproverIds: [] }),
  };
  const authenticator: Authenticator = {
    // 'good' is a valid session for opts.sub; anything else is rejected → 401.
    verify: vi.fn(async (token: string) => {
      if (token === 'good') return { sub: opts.sub ?? 'user_other' };
      throw new Error('invalid token');
    }),
  };
  return {
    config,
    authenticator,
    draftRepository: {
      create: vi.fn(async () => draft.id),
      findById: vi.fn(async (id: string) => (id === draft.id ? draft : null)),
      saveEditCheckpoint: vi.fn(async () => {}),
      approve: vi.fn(async () => {}),
      markSent: vi.fn(async () => {}),
    },
    auditWriter: {
      humanEdit: vi.fn(async () => ({ distanceChars: 3, editRate: 0.07 })),
      approved: vi.fn(async () => {}),
      sent: vi.fn(async () => {}),
    },
    emailSender: { send: vi.fn(async () => ({ messageId: 'ses_msg_1', recipientCount: 42 })) },
    slackConfirmer: { confirmSent: vi.fn(async () => {}) },
  };
}

const auth = { authorization: 'Bearer good' };

describe('API server', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const app = await buildServer(buildDeps());
    const res = await app.inject({ method: 'GET', url: `/drafts/${DRAFT_ID}` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns the draft envelope and an X-Run-Id header on GET', async () => {
    const app = await buildServer(buildDeps({ sub: COS_USER }));
    const res = await app.inject({ method: 'GET', url: `/drafts/${DRAFT_ID}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-run-id']).toBe('run_1');
    expect(res.json()).toMatchObject({ id: DRAFT_ID, status: 'PENDING' });
    await app.close();
  });

  it('serves /health without authentication', async () => {
    const app = await buildServer(buildDeps());
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
    await app.close();
  });

  it('rejects edits on a non-PENDING draft with 409', async () => {
    const app = await buildServer(
      buildDeps({ draft: sampleDraft({ status: 'SENT' }), sub: COS_USER }),
    );
    const res = await app.inject({
      method: 'POST',
      url: `/drafts/${DRAFT_ID}/edits`,
      headers: auth,
      payload: { editedText: 'a revised newsletter body' },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('rejects approval from a non-approver with 403', async () => {
    const app = await buildServer(buildDeps({ sub: 'user_not_cos' }));
    const res = await app.inject({
      method: 'POST',
      url: `/drafts/${DRAFT_ID}/approve`,
      headers: auth,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('approves, sends via SES, and audits in order for an approver', async () => {
    const deps = buildDeps({ sub: COS_USER });
    const app = await buildServer(deps);
    const res = await app.inject({
      method: 'POST',
      url: `/drafts/${DRAFT_ID}/approve`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'sent',
      sesMessageId: 'ses_msg_1',
      recipientCount: 42,
    });
    expect(deps.draftRepository.approve).toHaveBeenCalledTimes(1);
    expect(deps.emailSender.send).toHaveBeenCalledTimes(1);
    expect(deps.auditWriter.sent).toHaveBeenCalledTimes(1);
    expect(deps.draftRepository.markSent).toHaveBeenCalledTimes(1);
    expect(deps.slackConfirmer.confirmSent).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
