/**
 * Auth helper tests — the bearer-token parser and the approver check are the
 * security-critical surface of the API. extractBearerToken parses in linear
 * time rather than by regex: an overlapping-quantifier pattern such as
 * /^Bearer\s+(.+)$/ is a ReDoS risk, and these cases guard that property.
 *
 * createAuthenticator is exercised against a local key set through the real
 * `jose` path, so the signature/issuer/expiry checks are genuinely run rather
 * than asserted against a mocked SDK.
 */

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import type { SessionClaims } from "./auth.js";
import { createAuthenticator, extractBearerToken, isApprover, unsafeDecodeClaims } from "./auth.js";

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

describe("createAuthenticator", () => {
  // The real jose verification path against a local key set — no network, no
  // module-mocking of the SDK. This is the half of auth.ts that decides whether
  // a request is authenticated at all, and it previously had no test: coverage
  // sat at 36.8% of lines with every branch below this comment unexercised.
  const ISSUER = "https://example.authkit.app";
  const CLIENT_ID = "client_123";
  const EXPECTED_ISS = `${ISSUER}/user_management/${CLIENT_ID}`;

  let signingKey: CryptoKey;
  let jwks: ReturnType<typeof createLocalJWKSet>;
  let otherKey: CryptoKey;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    signingKey = pair.privateKey;
    jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: "RS256" }] });
    otherKey = (await generateKeyPair("RS256")).privateKey;
  });

  const sign = (claims: Record<string, unknown>, key: CryptoKey = signingKey, iss = EXPECTED_ISS) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(iss)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(key);

  const auth = () => createAuthenticator({ issuer: ISSUER, clientId: CLIENT_ID, jwks });

  it("returns the claims for a validly signed token", async () => {
    const token = await sign({ sub: "user_1", email: "a@example.com", sid: "sess_1" });
    const claims = await auth().verify(token);
    expect(claims.sub).toBe("user_1");
    expect(claims.email).toBe("a@example.com");
  });

  it("tolerates a trailing slash on the configured issuer", async () => {
    const token = await sign({ sub: "user_1" });
    const claims = await createAuthenticator({
      issuer: `${ISSUER}/`,
      clientId: CLIENT_ID,
      jwks,
    }).verify(token);
    expect(claims.sub).toBe("user_1");
  });

  it("resolves a remote key set when none is injected", () => {
    // The production arm. createRemoteJWKSet is lazy — it fetches on first
    // verify, not on construction — so this covers the default branch and
    // proves the JWKS URL composes, which `new URL` would reject if the issuer
    // were malformed.
    const a = createAuthenticator({ issuer: ISSUER, clientId: CLIENT_ID });
    expect(typeof a.verify).toBe("function");
  });

  it("rejects a token signed by a different key", async () => {
    const token = await sign({ sub: "user_1" }, otherKey);
    await expect(auth().verify(token)).rejects.toThrow();
  });

  it("rejects the bare issuer — AuthKit session tokens are per-Application", async () => {
    // iss is `<issuer>/user_management/<client_id>`, not `<issuer>`. Accepting
    // the bare form would accept a token minted for a different Application.
    const token = await sign({ sub: "user_1" }, signingKey, ISSUER);
    await expect(auth().verify(token)).rejects.toThrow();
  });

  it("rejects a token from another client_id in the same tenant", async () => {
    const token = await sign(
      { sub: "user_1" },
      signingKey,
      `${ISSUER}/user_management/client_other`,
    );
    await expect(auth().verify(token)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const token = await new SignJWT({ sub: "user_1" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(EXPECTED_ISS)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(signingKey);
    await expect(auth().verify(token)).rejects.toThrow();
  });

  it("rejects a verified token with no sub claim", async () => {
    // Signature and issuer are fine; the token identifies nobody. Without this
    // guard isApprover would compare `undefined` against the allow-list.
    const token = await sign({ email: "a@example.com" });
    await expect(auth().verify(token)).rejects.toThrow(/missing sub/i);
  });

  it("rejects a verified token whose sub is an empty string", async () => {
    const token = await sign({ sub: "" });
    await expect(auth().verify(token)).rejects.toThrow(/missing sub/i);
  });

  it("rejects a verified token whose sub is not a string", async () => {
    const token = await sign({ sub: 42 });
    await expect(auth().verify(token)).rejects.toThrow(/missing sub/i);
  });
});

describe("unsafeDecodeClaims", () => {
  it("decodes claims without verifying", async () => {
    const pair = await generateKeyPair("RS256");
    const token = await new SignJWT({ sub: "user_9" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://whatever")
      .setExpirationTime("5m")
      .sign(pair.privateKey);
    expect(unsafeDecodeClaims(token)?.sub).toBe("user_9");
  });

  it("returns null rather than throwing on an undecodable token", () => {
    expect(unsafeDecodeClaims("not-a-jwt")).toBeNull();
    expect(unsafeDecodeClaims("")).toBeNull();
  });
});
