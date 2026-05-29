import { authkitMiddleware } from '@workos-inc/authkit-nextjs';

// Pass redirectUri explicitly. AuthKit reads from NEXT_PUBLIC_WORKOS_REDIRECT_URI
// (NOT WORKOS_REDIRECT_URI — see authkit-nextjs's env-variables.js). Next.js
// inlines NEXT_PUBLIC_* values at build time, so the build-arg in
// Dockerfile.web is the load-bearing source. Passing it explicitly here is
// belt-and-suspenders: if the env propagates at runtime too, both work.
export default authkitMiddleware({
  redirectUri: process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI,
});

export const config = {
  // Exclude /api/auth/sign-in and /api/auth/sign-out specifically — those
  // routes generate AuthKit cookies (PKCE verifier, etc.) that collide with
  // the session-refresh middleware's own cookie writes when both fire on
  // the same response. /api/auth/me MUST go through the middleware, otherwise
  // withAuth() in that route reads a stale (un-refreshed) session and
  // returns user: null — the AuthStatus header then shows "Sign in" even
  // when the user is signed in.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|callback|api/health|api/auth/sign-in|api/auth/sign-out).*)'],
};
