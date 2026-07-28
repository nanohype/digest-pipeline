/**
 * API config tests.
 *
 * This module decides, at process start, whether the API is allowed to run.
 * Everything it validates is something that fails as a runtime surprise if it
 * slips through: a missing client id turns every token check into a 500, and
 * a mis-split CORS origin silently locks the review UI out of its own API.
 *
 * `loadApprovers` is not exercised here — it reaches Secrets Manager, which
 * belongs to the composition root. The schema it parses with is, since that is
 * the part with a decision in it.
 */

import { describe, expect, it } from "vitest";
import { ApproversSchema, loadApiConfig } from "./config.js";

// loadApiConfig reads ambient process.env and overlays these. Every key the
// schema knows about is pinned here — including the optional ones — so the
// suite asserts against a fixed environment rather than the shell it ran in.
// NODE_ENV is the concrete case: vitest sets it to "test", which is correctly
// not one of the three deployment environments this app has.
const REQUIRED = {
  NODE_ENV: undefined,
  PORT: undefined,
  AWS_REGION: undefined,
  WORKOS_ISSUER: undefined,
  WORKOS_CLIENT_ID: "client_01ABC",
  APPROVERS_SECRET_ID: "digest-pipeline/production/approvers",
  WEB_ORIGIN: "https://digest.example.com",
};

describe("loadApiConfig", () => {
  it("applies the documented defaults", () => {
    const { env } = loadApiConfig(REQUIRED);

    expect(env.NODE_ENV).toBe("development");
    expect(env.PORT).toBe(3001);
    expect(env.AWS_REGION).toBe("us-east-1");
    expect(env.WORKOS_ISSUER).toBe("https://api.workos.com");
  });

  it("coerces PORT from its string form, because env vars are always strings", () => {
    const { env } = loadApiConfig({ ...REQUIRED, PORT: "8080" });
    expect(env.PORT).toBe(8080);
  });

  it("splits WEB_ORIGIN on commas and trims each entry", () => {
    // The chart passes this through as one env var. A CORS origin that kept its
    // leading space never matches the browser's Origin header, and the failure
    // shows up as an opaque network error in the review UI rather than here.
    const { env } = loadApiConfig({
      ...REQUIRED,
      WEB_ORIGIN: "https://digest.example.com, https://staging.example.com ",
    });

    expect(env.WEB_ORIGIN).toEqual(["https://digest.example.com", "https://staging.example.com"]);
  });

  it("drops empty entries from a trailing comma", () => {
    const { env } = loadApiConfig({ ...REQUIRED, WEB_ORIGIN: "https://digest.example.com," });
    expect(env.WEB_ORIGIN).toEqual(["https://digest.example.com"]);
  });

  it.each([
    ["WORKOS_CLIENT_ID", { WORKOS_CLIENT_ID: undefined }],
    ["APPROVERS_SECRET_ID", { APPROVERS_SECRET_ID: undefined }],
    ["WEB_ORIGIN", { WEB_ORIGIN: undefined }],
  ])("refuses to start without %s", (_name, missing) => {
    expect(() => loadApiConfig({ ...REQUIRED, ...missing })).toThrow();
  });

  it("rejects an unknown NODE_ENV rather than treating it as development", () => {
    expect(() => loadApiConfig({ ...REQUIRED, NODE_ENV: "prod" })).toThrow();
  });

  it("rejects a WORKOS_ISSUER that is not a URL", () => {
    expect(() => loadApiConfig({ ...REQUIRED, WORKOS_ISSUER: "api.workos.com" })).toThrow();
  });

  it("rejects a non-positive PORT", () => {
    expect(() => loadApiConfig({ ...REQUIRED, PORT: "0" })).toThrow();
  });
});

describe("ApproversSchema", () => {
  it("accepts a CoS with no backups", () => {
    expect(ApproversSchema.parse({ cosUserId: "user_cos", backupApproverIds: [] })).toEqual({
      cosUserId: "user_cos",
      backupApproverIds: [],
    });
  });

  it("rejects a secret with an empty CoS id", () => {
    // isApprover compares claims.sub against this. An empty string would match
    // nothing, which fails safe — but it means the rotation silently disabled
    // approval for everyone, so it fails loudly at load instead.
    expect(() => ApproversSchema.parse({ cosUserId: "", backupApproverIds: [] })).toThrow();
  });

  it("rejects a backup list that is not an array of ids", () => {
    expect(() =>
      ApproversSchema.parse({ cosUserId: "user_cos", backupApproverIds: "user_a,user_b" }),
    ).toThrow();
  });
});
