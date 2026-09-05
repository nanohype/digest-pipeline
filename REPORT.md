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

**Covered.** It builds a real upstream git repository whose five commits it knows, runs
the shipped script against it as a subprocess through the `EKS_AGENT_PLATFORM_DIR` seam,
and asserts on the bytes that come back — exit code, no commit id in either the behind or
the current report, a remediation naming `--ref=latest` and no placeholder — then runs
`--ref=latest` against the same repository and requires the pin to land on the newest
commit touching the vendored path, the bytes and digests to match it, and `--check` to
accept the result. Three further cases cover the seam that makes `--ref` load-bearing: a
sync given no ref, run against a checkout standing on some other commit, must leave the
pin where it was and vendor the pin's bytes rather than the working tree's.

**Not covered, and why.**

- *The GitHub seam.* A fixture can drive the checkout seam and not the network one. The
  two differ only in how the two sides are read: neither arm resolves upstream's tip to a
  commit id at all (the variable was removed, not merely unprinted), and both hand the
  same sentences to one emitter, so the bytes asserted are the bytes that arm emits. It is
  not a check that raw.githubusercontent.com or the commits API is reachable —
  `--freshness` and `--ref=latest` fail loudly on that rather than reporting "current" or
  falling back to the pin.

- *The workflow's issue body.* The gate asserts the script's output, which the body embeds.
  The prose the workflow wraps around it is not gated: its only commit-shaped content is
  `PIN`, read from `schemas/crd/source.json` — a property of the tree, not of the run — and
  the rendered body was verified by hand. A later edit adding a run-resolved sha to the
  body would not fail this gate.

- *`platform.yaml` after a re-vendor.* `--ref=latest` is proven to land a tree `schemas:check`
  accepts. Whether the newly vendored bounds still admit this repository's `platform.yaml`
  is what `npm run platform:validate` answers, and the remediation names it as the second
  command for that reason.

## Mutants

Each applied to a copy of `scripts/sync-crd-schemas.mjs`, run through `--self-test`, and
required to fail. All ten are killed; the assertion that catches each is named.

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

## `--ref=latest` against real upstream

An agent auditing this branch ran the remediation against the live repository. It resolved
`84a70c8da1f5` — the newest commit touching `operators/config/crd/bases`, which matches what
the GitHub API reports independently — re-vendored the two schemas that changed, and rewrote
the digests. That run was reverted (the pin move is a separate item), but it stands as the
network seam exercised end to end, which the fixture-driven gate deliberately does not cover.

## The pin is untouched

`schemas/crd/source.json` still pins `0f56302c9e2d`. It is behind: `operators/config/crd/bases`
has moved three times since, and `2ec3ca4c48ef` tightens the `allowedModels` pattern to
require a version token. This repository's single entry, `anthropic.claude-sonnet-5`,
satisfies the tightened pattern, so adopting it is a re-vendor and a schema-diff review
rather than a manifest change — which is a separate item, and the one this repository's
drift issue now correctly instructs a reader to perform.
