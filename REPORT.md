# Freshness reports name a command, not a commit

Branch `crd-freshness`. Scope: the CRD schema freshness report and the drift issue it
files. What follows is what this repository could not fix from inside itself, and what
the gate here does and does not cover.

## Cross-repo: the same defect, in a file this repository may not edit

`scripts/sync-vendored.mjs` carries the defect in its purest form. `runFreshness` emits:

```
✗ the pin <pin12> is behind <repository>@<tip12>:
      <path> — changed upstream since the pin

    Adopt the newer library when convenient: `npm run sync:vendored -- --ref=<tip40>`,
```

The remediation interpolates a **full 40-character commit resolved during that run**. It
is read from `.github/workflows/vendored-freshness.yml`, which runs weekly and whose red
run is the notification. A reader acting on a run log from any earlier week re-vendors to
a commit that is no longer the newest.

It cannot be fixed here. `scripts/vendored.json` declares

```json
{ "src": "library/scripts/sync-vendored.mjs", "dest": "scripts/sync-vendored.mjs" }
```

so the file is a byte-identical vendored copy of `nanohype/nanohype`, and
`npm run sync:vendored:check` (`checkEntry`, blocking, in the `vendored` CI job that the
merge gate depends on) fails the moment a byte differs. Editing it here trades a stale
instruction for a red required check.

**Belongs in `nanohype/nanohype`, at `library/scripts/sync-vendored.mjs`.** The shape that
works is the one landed here:

- `runFreshness` needs the tip to *compare*, not to *print* — drop `tip.slice(0, 12)` from
  the verdict line and interpolate nothing into the remediation.
- Add `--ref=latest`, resolved through the seam `bindUpstream` already declares
  (`git log -1 --format=%H -- <src>` over the manifest's entries), so the remediation names
  a command that exists.
- The vendored manifest has many entries rather than one path, so `latest` there resolves
  the newest commit touching **any** declared `src` — the union, not one path.

Once it lands upstream, `npm run sync:vendored -- --ref=<sha>` here re-vendors the fix and
`vendored-freshness.yml`'s report inherits it. No change to this repository is needed for
that beyond moving the pin.

## What portal's version does not cover

Read against `nanohype/portal` 6b08635, which is the reference this was built from.

1. **The abbreviation gap.** Portal's gate greps `[0-9a-f]{40}`. This repository prints
   `slice(0, 12)`, which that grep walks straight past — the defect would have shipped
   under portal's gate unchanged. The gate here strips the pin and then rejects both any
   40-character hex run and any prefix of a known fixture commit down to seven characters.

2. **The fixture that cannot tell two wrong answers apart.** Portal's fixture makes the
   repository's HEAD and the vendored path's newest commit the same commit, so a resolver
   reaching for `rev-parse HEAD` instead of `log -1 -- <path>` passes it. The fixture here
   adds a newest commit that touches nothing vendored, and mutant M5 fails against it.

3. **The exit-0 report.** Portal asserts only on the behind report. "Current" is also
   printed prose, and it is also a place to put a resolved commit. Covering it needs a
   fixture where a pin can be current while *not* being the path's newest commit — reached
   here with a commit that reverts an earlier one, so `moved` and `restored` hold identical
   bytes at different commits. Without that, the pin and the resolvable head coincide, a
   sha printed there is stripped as the pin, and mutant M6 survives. It did, on the first
   fixture; the revert commit is what kills it.

4. **The fixture's own premise, asserted.** Two cases assert that the fixture still holds
   the same bytes at two commits and that its newest commit is not the path's newest. A
   later edit that collapses either leaves every other assertion passing while silently
   reopening (2) and (3). Mutants M8 and M9 are those collapses.

5. **The instruction leaves a tree the blocking gate accepts.** Portal proves the pin moves.
   It does not prove the resulting tree passes `check`. Following a remediation that trades
   a stale issue for a red required check is not a fix, so the gate here runs `--check`
   against the re-vendored tree.

6. **The diff the instruction tells you to read.** Both the report and the issue body say
   "review the schema diff" and neither gave a way to get one. A compare link whose second
   operand is `HEAD` resolves when it is clicked, which is the same move as `-- latest`
   applied to reading rather than to re-vendoring.

## What the gate covers, and what it does not

`npm run schemas:selftest` (`scripts/sync-crd-schemas.mjs --self-test`, wired into the
`crd-schema-drift` CI job, `task ci`, and `Taskfile` `schemas:selftest`).

**Covered.** It builds real upstream git repositories whose commits it knows and runs the
shipped script against them as a subprocess, over **both** seams — a checkout through
`EKS_AGENT_PLATFORM_DIR`, and the network arm against an HTTP server the gate itself runs,
serving the same fixture through the two GitHub shapes the script depends on. The scheduled
workflow sets no checkout, so the network arm is the one production executes; a gate that
drove only the other would assert a path that never runs.

On the emitted bytes: exit 2 for a behind pin on both seams, no commit id in the behind
report or the current one, a remediation naming `--ref=latest` and no placeholder. Then the
command is run for real and required to land the pin on the newest commit touching the
vendored path — from a checkout and over the API — with the bytes and digests following it
and `--check` accepting the result.

Around that: a sync given no ref must move nothing; a pin no checkout holds and an
unreachable upstream must exit 1, never the 2 that means confirmed drift; a shallow clone
must be refused rather than pinned to; a schema deleted upstream must read as drift on both
seams rather than as "current"; and anything written to `GITHUB_STEP_SUMMARY` or
`GITHUB_OUTPUT` is folded into what the assertions scan, because under Actions those are
prose the reader sees exactly like stdout.

The detector is itself under test. Four negative controls require it to catch a
four-character abbreviation, catch an upper-case one, let the pin through, and not mistake
a 64-character sha256 for a 40-character commit id. Every staleness case asserts `=== null`,
so without them the whole class would pass by the detector never firing at all.

**Not covered, and why.**

- *That the real hosts are reachable.* The fixture server proves the arm's own logic — its
  parsing, its 404 handling, its shared report body. It is not a check that
  raw.githubusercontent.com or the commits API answers; `--freshness` and `--ref=latest`
  fail loudly on that rather than reporting "current" or falling back to the pin.

- *The workflow's prose.* The gate asserts the script's output, which the issue body quotes.
  The wrapper prose is not gated — so it no longer restates the remediation or the compare
  link. Every commit-shaped string in the rendered body now arrives inside the quoted
  report, which is the half that is asserted. A second copy would be the half that goes
  stale.

- *A CRD added upstream.* Both seams iterate `manifest.files`, so a new schema appearing
  under the vendored path is never compared and the report can say "current" while upstream
  carries a CRD this repository has never seen. Real, pre-existing, and a change to what the
  verdict means rather than to what it says — noted below rather than fixed here.

- *`platform.yaml` after a re-vendor.* `--ref=latest` is proven to land a tree `schemas:check`
  accepts. Whether the newly vendored bounds still admit this repository's `platform.yaml`
  is what `npm run platform:validate` answers, and the remediation names it for that reason.

## Mutants

Each applied to a copy of `scripts/sync-crd-schemas.mjs`, run through `--self-test`, and
required to fail. All nineteen are killed; the assertion that catches each is named. M11
through M19 are the holes this gate's first version left open — each was verified green
against it before the case that now catches it existed.

| # | mutation | assertion that fails |
|---|---|---|
| M1 | the verdict line names the commit upstream moved to | the behind report names no upstream commit id |
| M2 | the per-file line names it | the behind report names no upstream commit id |
| M3 | the remediation reverts to `--ref=<sha>` | the behind report names a command that resolves upstream HEAD when it runs |
| M4 | `latest` falls back to the pin instead of resolving | `--ref=latest` lands the pin on the newest commit touching the vendored path |
| M5 | `latest` resolves the checkout's HEAD, not the path's newest commit | `--ref=latest` lands the pin on the newest commit touching the vendored path |
| M6 | the current (exit 0) line names the commit upstream is at | the current report names no upstream commit id either |
| M7 | a behind pin exits 1, collapsing "behind" into "could not find out" | a behind pin exits 2, the code the scheduled workflow files an issue on |
| M8 | the fixture stops reverting, so a current pin equals the path's newest commit | the fixture holds the same schema bytes at two different commits |
| M9 | the fixture's newest commit touches the vendored path | `--ref=latest` lands the pin on the newest commit touching the vendored path |
| M10 | a checkout is read from its working tree in every mode | `--ref=latest` lands the pin on the newest commit touching the vendored path |
| M11 | the verdict names a six-character abbreviation | the behind report names no upstream commit id |
| M12 | the verdict names an upper-case abbreviation | the behind report names no upstream commit id |
| M13 | the detector's abbreviation loop is disabled | the detector finds a commit id an abbreviation short of git's own floor |
| M14 | the detector's 40-hex test is unanchored, so a digest reads as a commit | the detector does not mistake a sha256 digest for a commit id |
| M15 | the commit id goes to the Actions step summary instead of stdout | the behind report names no upstream commit id |
| M16 | `die()` exits 2, so "could not find out" reads as confirmed drift | a pin no checkout holds exits 1, not the 2 that means confirmed drift |
| M17 | the shallow-clone refusal is disabled | `--ref=latest` refuses a shallow clone rather than pinning to what it happens to hold |
| M18 | `latest` over the network seam returns the pin instead of the API's answer | `--ref=latest` resolves over the network seam too, not only from a checkout |
| M19 | the network seam reports a file absent at HEAD as unchanged | the network seam calls a schema removed upstream drift, not "current" |

## `--ref=latest` against real upstream

An agent auditing this branch ran the remediation against the live repository. It resolved
`84a70c8da1f5` — the newest commit touching `operators/config/crd/bases`, which matches what
the GitHub API reports independently — re-vendored the two schemas that changed, and rewrote
the digests. That run was reverted (the pin move is a separate item), but it stands as the
network seam exercised end to end, which the fixture-driven gate deliberately does not cover.

## Adjacent findings, not fixed here

Surfaced while auditing this class; each is a separate item.

- **`scripts/sync-crd-schemas.mjs` never notices a CRD added upstream.** Both seams iterate
  `manifest.files`. Closing it means listing the directory upstream — `git ls-tree` on the
  checkout seam, the contents API otherwise — and reporting a `.yaml` present there and
  absent from the manifest.
- **`scripts/validate-platform-manifests.mjs:247` and `:267`** answer "source.json is
  unreadable" and "schemas/crd/ is missing" with `npm run schemas:sync`, which reads
  source.json before it can do anything. The recovery that works is
  `git checkout -- schemas/crd/`.
- **`AGENTS.md:161`** describes editing a vendored copy and re-syncing. `sync-vendored.mjs`
  reads every blob through `blobAt` at the pinned ref, never the working tree, so the
  described edit is silently discarded.
- **`scripts/seed-secrets.sh:47`** states a count in `--help` that line 171 also computes
  from `REQUIRED_KEYS`. Two copies, one of which nothing keeps true.

## The pin is untouched

`schemas/crd/source.json` still pins `0f56302c9e2d`. Whether that pin is behind is what
`npm run schemas:freshness` answers, weekly and on demand — not something this document
should assert, since the answer changes when someone pushes to another repository. Adopting
a newer operator API is a separate item: a re-vendor plus the schema-diff review the drift
issue now instructs a reader to perform.
