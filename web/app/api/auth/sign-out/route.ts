import { signOut } from '@workos-inc/authkit-nextjs';

export const dynamic = 'force-dynamic';

// AuthKit's signOut() clears the session cookie + redirects to the WorkOS
// hosted "you've been signed out" page (or the configured logoutRedirectUri).
// GET so a plain anchor tag works without a form/POST.
export async function GET() {
  await signOut();
}
