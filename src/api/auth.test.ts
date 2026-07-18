/**
 * Auth helper tests — the bearer-token parser and the approver check are
 * security-critical and were previously untested. extractBearerToken is
 * additionally a ReDoS regression guard after the /^Bearer\s+(.+)$/ pattern
 * (overlapping quantifiers) was replaced with linear-time parsing.
 */

import { describe, expect, it } from "vitest";
import type { SessionClaims } from "./auth.js";
import { extractBearerToken, isApprover } from "./auth.js";

describe("extractBearerToken", () => {
  it("extracts the token after Bearer", () => {
    expect(extractBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("is case-insensitive and tolerates extra whitespace", () => {
    expect(extractBearerToken("bearer   tok")).toBe("tok");
    expect(extractBearerToken("BEARER\ttok")).toBe("tok");
  });

  it("returns null for missing or malformed headers", () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken("")).toBeNull();
    expect(extractBearerToken("Basic xyz")).toBeNull();
    expect(extractBearerToken("Bearer")).toBeNull();
    expect(extractBearerToken("Bearer    ")).toBeNull();
  });

  it("stays linear-time on a crafted all-whitespace header (ReDoS guard)", () => {
    const evil = `Bearer ${" ".repeat(100_000)}`;
    const start = performance.now();
    expect(extractBearerToken(evil)).toBeNull();
    expect(performance.now() - start).toBeLessThan(100);
  });
});

describe("isApprover", () => {
  const claims = (sub: string): SessionClaims => ({ sub });

  it("accepts the CoS and backup approvers, rejects everyone else", () => {
    const approvers = { cosUserId: "cos", backupApproverIds: ["b1", "b2"] };
    expect(isApprover(claims("cos"), approvers)).toBe(true);
    expect(isApprover(claims("b2"), approvers)).toBe(true);
    expect(isApprover(claims("intruder"), approvers)).toBe(false);
  });
});
