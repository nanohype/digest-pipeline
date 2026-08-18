/**
 * API server tests — the approve/send orchestrator is the security-critical
 * surface, so it gets behavior tests at the HTTP boundary via Fastify's
 * built-in app.inject() (no real sockets). Dependencies are injected as
 * fakes through ServerDeps, including a stub Authenticator so no real WorkOS
 * JWKS is hit. Mirrors the port-injection pattern used in generator.test.ts.
 */

import { describe, expect, it, vi } from "vitest";
import type { Draft } from "../pipeline/types.js";
import type { Authenticator } from "./auth.js";
import type { ApiConfig } from "./config.js";
import { buildServer, type ServerDeps } from "./server.js";

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
const COS_USER = "user_cos";

function sampleDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    id: DRAFT_ID,
    runId: "run_1",
    weekOf: new Date("2026-06-19T00:00:00Z"),
    status: "PENDING",
    sections: [],
    fullText: "Hello team, here is what shipped this week.",
    createdAt: new Date("2026-06-19T09:00:00Z"),
    ...overrides,
  };
}

function buildDeps(opts: { draft?: Draft; sub?: string } = {}): ServerDeps {
  const draft = opts.draft ?? sampleDraft();
  const config: ApiConfig = {
    env: {
      NODE_ENV: "development",
      PORT: 3001,
      AWS_REGION: "us-east-1",
      WORKOS_ISSUER: "https://api.workos.com",
      WORKOS_CLIENT_ID: "client_test",
      APPROVERS_SECRET_ID: "approvers",
      WEB_ORIGIN: ["http://localhost:3000"],
    },
    secrets: {
      getJson: async () => {
        throw new Error("secrets are not used in these tests");
      },
    },
    loadApprovers: async () => ({ cosUserId: COS_USER, backupApproverIds: [] }),
  };
  const authenticator: Authenticator = {
    // 'good' is a valid session for opts.sub; anything else is rejected → 401.
    verify: vi.fn(async (token: string) => {
      if (token === "good") return { sub: opts.sub ?? "user_other" };
      throw new Error("invalid token");
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
      expirePending: vi.fn(async () => []),
    },
    auditWriter: {
      humanEdit: vi.fn(async () => ({ distanceChars: 3, editRate: 0.07 })),
      approved: vi.fn(async () => {}),
      sent: vi.fn(async () => {}),
    },
    emailSender: { send: vi.fn(async () => ({ messageId: "ses_msg_1", recipientCount: 42 })) },
    slackConfirmer: { confirmSent: vi.fn(async () => {}) },
  };
}

const auth = { authorization: "Bearer good" };

describe("API server", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const app = await buildServer(buildDeps());
    const res = await app.inject({ method: "GET", url: `/drafts/${DRAFT_ID}` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns the draft envelope and an X-Run-Id header on GET", async () => {
    const app = await buildServer(buildDeps({ sub: COS_USER }));
    const res = await app.inject({ method: "GET", url: `/drafts/${DRAFT_ID}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-run-id"]).toBe("run_1");
    expect(res.json()).toMatchObject({ id: DRAFT_ID, status: "PENDING" });
    await app.close();
  });

  it("serves /health without authentication", async () => {
    const app = await buildServer(buildDeps());
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
    await app.close();
  });

  it("rejects edits on a non-PENDING draft with 409", async () => {
    const app = await buildServer(
      buildDeps({ draft: sampleDraft({ status: "SENT" }), sub: COS_USER }),
    );
    const res = await app.inject({
      method: "POST",
      url: `/drafts/${DRAFT_ID}/edits`,
      headers: auth,
      payload: { editedText: "a revised newsletter body" },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("rejects approval from a non-approver with 403", async () => {
    const app = await buildServer(buildDeps({ sub: "user_not_cos" }));
    const res = await app.inject({
      method: "POST",
      url: `/drafts/${DRAFT_ID}/approve`,
      headers: auth,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("approves, sends via SES, and audits in order for an approver", async () => {
    const deps = buildDeps({ sub: COS_USER });
    const app = await buildServer(deps);
    const res = await app.inject({
      method: "POST",
      url: `/drafts/${DRAFT_ID}/approve`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "sent",
      sesMessageId: "ses_msg_1",
      recipientCount: 42,
    });
    expect(deps.draftRepository.approve).toHaveBeenCalledTimes(1);
    expect(deps.emailSender.send).toHaveBeenCalledTimes(1);
    expect(deps.auditWriter.sent).toHaveBeenCalledTimes(1);
    expect(deps.draftRepository.markSent).toHaveBeenCalledTimes(1);
    expect(deps.slackConfirmer.confirmSent).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("mails the draft the reviewer sees, escaped for HTML", async () => {
    const deps = buildDeps({
      sub: COS_USER,
      draft: sampleDraft({ fullText: 'Ship <b>fast</b> & "well"' }),
    });
    const app = await buildServer(deps);
    await app.inject({ method: "POST", url: `/drafts/${DRAFT_ID}/approve`, headers: auth });

    const sent = vi.mocked(deps.emailSender.send).mock.calls[0][0];
    // The body is model output assembled from Slack, GitHub, Linear and Notion
    // strings and then hand-edited. It goes out to the whole company as HTML,
    // so markup in it has to arrive as text.
    expect(sent.textBody).toBe('Ship <b>fast</b> & "well"');
    expect(sent.htmlBody).toContain("Ship &lt;b&gt;fast&lt;/b&gt; &amp; &quot;well&quot;");
    expect(sent.htmlBody).not.toContain("<b>fast</b>");
    expect(sent.subject).toContain("Week of");
    await app.close();
  });
});

describe("POST /drafts/:id/edits", () => {
  it("audits the edit, records the rate, and checkpoints the text", async () => {
    const deps = buildDeps({ sub: COS_USER });
    const app = await buildServer(deps);
    const res = await app.inject({
      method: "POST",
      url: `/drafts/${DRAFT_ID}/edits`,
      headers: auth,
      payload: { editedText: "a revised newsletter body" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "saved" });
    expect(res.headers["x-run-id"]).toBe("run_1");
    // The ledger measures the human's edit against what the model produced, so
    // it has to receive both texts — the delta is derived once, here, and never
    // recomputed from the current draft.
    expect(deps.auditWriter.humanEdit).toHaveBeenCalledWith(
      "run_1",
      DRAFT_ID,
      COS_USER,
      "Hello team, here is what shipped this week.",
      "a revised newsletter body",
    );
    expect(deps.draftRepository.saveEditCheckpoint).toHaveBeenCalledWith(
      DRAFT_ID,
      "a revised newsletter body",
      COS_USER,
    );
    await app.close();
  });

  it("rejects an empty edit with 400 before anything is written", async () => {
    const deps = buildDeps({ sub: COS_USER });
    const app = await buildServer(deps);
    const res = await app.inject({
      method: "POST",
      url: `/drafts/${DRAFT_ID}/edits`,
      headers: auth,
      payload: { editedText: "" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "ValidationError" });
    expect(deps.auditWriter.humanEdit).not.toHaveBeenCalled();
    expect(deps.draftRepository.saveEditCheckpoint).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("request validation and lookup", () => {
  it("rejects a malformed draft id with 400 and never reaches the repository", async () => {
    const deps = buildDeps({ sub: COS_USER });
    const app = await buildServer(deps);
    const res = await app.inject({ method: "GET", url: "/drafts/not-a-uuid", headers: auth });

    expect(res.statusCode).toBe(400);
    expect(res.json().issues).toBeDefined();
    expect(deps.draftRepository.findById).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 404 for a well-formed id that does not exist", async () => {
    const app = await buildServer(buildDeps({ sub: COS_USER }));
    const res = await app.inject({
      method: "GET",
      url: "/drafts/22222222-2222-4222-8222-222222222222",
      headers: auth,
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns 404 when approving a draft that does not exist", async () => {
    const app = await buildServer(buildDeps({ sub: COS_USER }));
    const res = await app.inject({
      method: "POST",
      url: "/drafts/22222222-2222-4222-8222-222222222222/approve",
      headers: auth,
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("rejects approval of a non-PENDING draft with 409 and sends no mail", async () => {
    const deps = buildDeps({ draft: sampleDraft({ status: "SENT" }), sub: COS_USER });
    const app = await buildServer(deps);
    const res = await app.inject({
      method: "POST",
      url: `/drafts/${DRAFT_ID}/approve`,
      headers: auth,
    });

    expect(res.statusCode).toBe(409);
    expect(deps.emailSender.send).not.toHaveBeenCalled();
    await app.close();
  });

  /**
   * Expiry only became reachable when the weekly run started closing out last
   * week's drafts, so until now nothing had to refuse an EXPIRED one — it was
   * simply a status no row ever held. A state that looks like a guard but is
   * never exercised is not a guard, so the refusal is pinned here: no mail
   * leaves, and the draft is not marked sent.
   */
  it("refuses to approve or send an EXPIRED draft", async () => {
    const deps = buildDeps({ draft: sampleDraft({ status: "EXPIRED" }), sub: COS_USER });
    const app = await buildServer(deps);
    const res = await app.inject({
      method: "POST",
      url: `/drafts/${DRAFT_ID}/approve`,
      headers: auth,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: expect.stringContaining("EXPIRED") });
    expect(deps.emailSender.send).not.toHaveBeenCalled();
    expect(deps.draftRepository.approve).not.toHaveBeenCalled();
    expect(deps.draftRepository.markSent).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a token the verifier refuses with 401", async () => {
    // Distinct from the missing-token case: this is the path that decodes the
    // claims for the diagnostic log line, and it had no test.
    const deps = buildDeps({ sub: COS_USER });
    const app = await buildServer(deps);
    const res = await app.inject({
      method: "GET",
      url: `/drafts/${DRAFT_ID}`,
      headers: { authorization: "Bearer expired" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "Invalid or expired token" });
    expect(deps.draftRepository.findById).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 500 without leaking the reason when a dependency fails", async () => {
    const deps = buildDeps({ sub: COS_USER });
    deps.draftRepository.findById = vi.fn(async () => {
      throw new Error("connection terminated unexpectedly");
    });
    const app = await buildServer(deps);
    const res = await app.inject({ method: "GET", url: `/drafts/${DRAFT_ID}`, headers: auth });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "InternalServerError" });
    expect(res.payload).not.toContain("connection terminated");
    await app.close();
  });
});
