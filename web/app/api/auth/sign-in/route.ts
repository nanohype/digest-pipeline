import { redirect } from 'next/navigation';
import { getSignInUrl } from '@workos-inc/authkit-nextjs';

export const dynamic = 'force-dynamic';

// Calling getSignInUrl() from a server component throws because it sets a
// PKCE verifier cookie, and Next.js only allows cookie mutations inside
// Route Handlers / Server Actions. This route handler is the allowed seam:
// build the URL (which sets the verifier cookie), then 302 to WorkOS.
export async function GET() {
  const signInUrl = await getSignInUrl();
  redirect(signInUrl);
}
