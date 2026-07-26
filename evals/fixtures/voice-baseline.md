Morning, everyone.

A lot landed this past fortnight, and most of it was the unglamorous kind that makes next quarter easier. Two things worth reading past the headlines: the search rewrite is finally out of the experiment flag, and we have a date for the warehouse cutover.

## 🚀 What Shipped

**Search relevance rewrite** — Query latency dropped from 900ms to 210ms at p95, and the recall numbers held steady through the whole rollout. This has been in flight since January. _Priya Raghavan_

**Billing retries** — Failed card charges now retry on a schedule instead of dropping straight to support. Early numbers suggest about a third of them recover without anyone touching them. _Marcus Bell_

**Audit log export** — Enterprise customers can pull their own audit trail without filing a ticket, which removes the single most common reason people open one. _Jonah Adeyemi_

**Session handling on mobile** — Users no longer get logged out when they background the app for more than an hour. Small fix, large amount of accumulated annoyance removed. _Ines Delacroix_

## 📅 What's Coming

**Single sign-on for the mobile app** — Design review Tuesday, build starts the week after. This is the last piece blocking two enterprise deals. _Priya Raghavan_

**Warehouse sync v2** — The rewrite that unblocks the analytics roadmap. We have a cutover date now: the 28th, with a rollback window through that weekend. _Ines Delacroix_

**Onboarding checklist redesign** — Research wrapped, designs are in review. Expect something to look at by the end of next week. _Marcus Bell_

## 👋 New Joiners

**Tobias Lindqvist** joins Platform as a Staff Engineer. He spent the last four years on database internals and has already filed two bugs against our own migration tooling, which is a strong start.

**Amara Okonjo** joins Support Engineering. She comes from a team that ran a similar escalation model, so expect some pointed questions about our runbooks.

## 🏆 Wins & Recognition

**Ines Delacroix** spent three days pairing with support on a customer escalation that turned out to be our bug. She found it, fixed it, and wrote the postmortem without being asked.

**The on-call rotation** went a full week without a page for the first time since we started tracking. That is the compounding result of a lot of unglamorous alert tuning.

**Jonah Adeyemi** quietly cut our CI bill by a third by noticing we were rebuilding the same container layer on every job.

## 📣 The Ask

Please get your Q3 planning docs in by Thursday — the roadmap review moved up a week and we genuinely cannot do it without the inputs. If yours is going to be late, say so now rather than Thursday afternoon.

Anything I missed? Reply here and I will add it next week.
