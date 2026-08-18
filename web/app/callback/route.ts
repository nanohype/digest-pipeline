import { handleAuth } from '@workos-inc/authkit-nextjs';

// Pass `baseURL` explicitly. Without it AuthKit falls back to `request.url`
// for the post-sign-in redirect (see authkit-callback-route.js:59), and behind
// an ALB Next.js sometimes resolves `request.url`'s host to the pod's own
// cluster-internal address rather than the public host the browser used. The
// browser then can't resolve it. The redirect URI is a public OAuth callback,
// so its origin is the right post-sign-in base.
//
// AuthKit reads from NEXT_PUBLIC_WORKOS_REDIRECT_URI, not WORKOS_REDIRECT_URI
// (see authkit-nextjs's env-variables.js). Match that name here.
const REDIRECT_URI = process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI;
const BASE_URL = REDIRECT_URI ? new URL(REDIRECT_URI).origin : undefined;

export const GET = handleAuth({ baseURL: BASE_URL });
