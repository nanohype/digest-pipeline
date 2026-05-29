'use client';

/**
 * AuthStatus — small header element showing "Signed in as <email>" or a
 * "Sign in" link. Lives client-side because the underlying session lookup
 * (`withAuth()`) wants to mutate cookies, and Next.js only permits that
 * in Route Handlers — so we fetch /api/auth/me from a useEffect.
 */

import { useEffect, useState } from 'react';

interface User {
  email: string;
  id: string;
}

export function AuthStatus() {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'in'; user: User } | { status: 'out' }>({
    status: 'loading',
  });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        setState(body.user ? { status: 'in', user: body.user } : { status: 'out' });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ status: 'out' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === 'loading') {
    return <p className="auth-status">&nbsp;</p>;
  }
  if (state.status === 'in') {
    return (
      <p className="auth-status">
        Signed in as <strong>{state.user.email}</strong> ·{' '}
        <a className="auth-link" href="/api/auth/sign-out">
          Sign out
        </a>
      </p>
    );
  }
  return (
    <p className="auth-status">
      <a className="auth-link" href="/api/auth/sign-in">
        Sign in &rarr;
      </a>
    </p>
  );
}
