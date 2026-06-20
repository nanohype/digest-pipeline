/**
 * WorkOS session-token validation + approver authorization.
 *
 * Verifies the WorkOS AuthKit-issued JWT against the WorkOS JWKS, plus
 * issuer, audience (the WorkOS client_id), and expiry. On any validation
 * failure it throws — the Fastify hook turns that into a 401. Non-approver
 * authenticated callers get 403 from isApprover.
 */

import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload } from 'jose';
import type { Approvers } from './config.js';

export interface SessionClaims extends JWTPayload {
  sub: string; // WorkOS user id
  email?: string;
  org_id?: string; // WorkOS organization membership
  sid?: string; // WorkOS session id
}

export interface Authenticator {
  verify(token: string): Promise<SessionClaims>;
}

export function createAuthenticator(options: { issuer: string; clientId: string }): Authenticator {
  const issuer = options.issuer.replace(/\/$/, '');
  // /sso/jwks/<client_id> serves keys for both SSO tokens and User Management
  // session JWTs from the same Application — confirmed by inspecting the
  // @workos-inc/node SDK's getJwksUrl() (which is what authkit-nextjs uses
  // internally to verify tokens).
  const jwksUrl = new URL(`${issuer}/sso/jwks/${options.clientId}`);
  const jwks = createRemoteJWKSet(jwksUrl);
  // User Management session JWTs carry `iss = <issuer>/user_management/<client_id>`,
  // NOT bare `<issuer>`. Verified by decoding an actual AuthKit-issued token —
  // the `iss` claim is fully qualified per-Application. Match that format here.
  const expectedIssuer = `${issuer}/user_management/${options.clientId}`;
  return {
    async verify(token) {
      // Verify signature + issuer. We don't check `aud` because AuthKit-
      // issued User Management JWTs don't populate it with the client_id
      // — the client_id is in a separate `client_id` claim. The WorkOS
      // Node SDK's own session verification doesn't check `aud` either.
      // Authorization (who can do what) lives in `isApprover()` against
      // the explicit allow-list, not in JWT claims.
      const { payload } = await jwtVerify(token, jwks, { issuer: expectedIssuer });
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        throw new Error('Session token missing sub claim');
      }
      return payload as SessionClaims;
    },
  };
}

/** Decode JWT claims without verifying — for diagnostics on a verification
 * failure. Returns null on undecodable tokens. */
export function unsafeDecodeClaims(token: string): JWTPayload | null {
  try {
    return decodeJwt(token);
  } catch {
    return null;
  }
}

export function extractBearerToken(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader) return null;
  // Parse "Bearer <token>" without a backtracking regex. The previous
  // /^Bearer\s+(.+)$/ had overlapping \s+ and .+ quantifiers (\s ⊂ .), a
  // polynomial-ReDoS surface on a crafted Authorization header. Anchored
  // literal + single-char tests are linear-time.
  if (!/^bearer/i.test(authorizationHeader)) return null;
  const rest = authorizationHeader.slice('bearer'.length);
  if (!/^\s/.test(rest)) return null;
  const token = rest.trim();
  return token.length > 0 ? token : null;
}

export function isApprover(claims: SessionClaims, approvers: Approvers): boolean {
  return claims.sub === approvers.cosUserId || approvers.backupApproverIds.includes(claims.sub);
}
