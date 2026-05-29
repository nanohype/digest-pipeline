# dispatch-web

Next.js 16 (App Router) review + approval UI for the dispatch newsletter pipeline. WorkOS AuthKit handles sign-in; every data fetch proxies through server-side route handlers at `/api/drafts/*` that extract the access token from the AuthKit session cookie and forward it to the dispatch Fastify API.

## Run locally

```bash
cp .env.example .env.local
npm install
npm run dev
```

Opens on http://localhost:3000. The `/review/:draftId` route needs a live dispatch API at `API_BASE_URL` to return real drafts; without one you'll hit a 502 on the proxy call.

## Build for production

```bash
npm run build
# Produces .next/standalone for Dockerfile.web consumption.
```

## Layout

```
app/
  layout.tsx            Root layout
  page.tsx              Home / landing
  globals.css           Design tokens + page styles
  callback/route.ts     WorkOS AuthKit callback handler
  review/[draftId]/
    page.tsx            The review + approve screen
  api/
    health/route.ts           GET /api/health (ALB)
    drafts/[id]/route.ts                     GET proxy
    drafts/[id]/edits/route.ts               POST proxy
    drafts/[id]/approve/route.ts             POST proxy
middleware.ts           WorkOS AuthKit session middleware
components/
  ApproveButton.tsx     Approve-and-send
  DiffIndicator.tsx     Live edit-rate chip
lib/
  auth.ts               WorkOS AuthKit helpers (withAuth, getAccessToken)
  api.ts                proxyRequest helper
  diff.ts               Levenshtein with sampling fallback
```
