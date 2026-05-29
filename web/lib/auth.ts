/**
 * WorkOS AuthKit helpers. Re-exports the pieces of authkit-nextjs that
 * route handlers and server components use, plus a thin getAccessToken
 * helper for the proxy layer.
 */

import { withAuth, getSignInUrl } from '@workos-inc/authkit-nextjs';

export { withAuth, getSignInUrl };

export async function getAccessToken(): Promise<string | null> {
  const { accessToken } = await withAuth();
  return accessToken ?? null;
}
