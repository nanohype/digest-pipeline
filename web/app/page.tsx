import { AuthStatus } from "@/components/AuthStatus";

// Static server component. Auth status renders client-side via AuthStatus,
// because AuthKit's withAuth() / getSignInUrl() both want to mutate cookies
// (token refresh + PKCE verifier respectively), and Next.js only allows
// cookie mutations inside Route Handlers / Server Actions. Calling them
// from this server component throws at render. Sign-in flow goes through
// /api/auth/sign-in, sign-out through /api/auth/sign-out, both Route
// Handlers where mutation is fine.
export default function HomePage() {
  return (
    <main className="page-shell">
      <header className="review-header">
        <div className="review-header-row">
          <h1>DigestPipeline</h1>
          <AuthStatus />
        </div>
        <p className="muted">
          Weekly newsletter review for the Chief of Staff. Open a draft from the Slack notification
          link, or sign in to view the latest pending draft.
        </p>
      </header>
      <section className="card" style={{ marginTop: 24 }}>
        <h2>Getting here</h2>
        <p>
          DigestPipeline posts a link into <code>#newsletter-review</code> every Friday morning.
          Click that link to land on the review page for the week&apos;s draft.
        </p>
      </section>
    </main>
  );
}
