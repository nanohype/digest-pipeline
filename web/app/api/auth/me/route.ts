import { NextResponse } from 'next/server';
import { withAuth } from '@workos-inc/authkit-nextjs';

export const dynamic = 'force-dynamic';

// Read-only session check. Lives in a Route Handler (where AuthKit's
// auto-refresh can mutate cookies safely) so the page server component
// can stay free of cookie-mutation crashes.
export async function GET() {
  try {
    const { user } = await withAuth();
    if (!user) return NextResponse.json({ user: null }, { status: 200 });
    return NextResponse.json({ user: { email: user.email, id: user.id } });
  } catch {
    return NextResponse.json({ user: null }, { status: 200 });
  }
}
