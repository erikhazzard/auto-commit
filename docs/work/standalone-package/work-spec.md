# WORK SPEC — Standalone Auto Commit

**Purpose:** Give every repository one installable, pinned `auto-commit` command that turns a settled Git delta into a safe forward commit with a concise, evidence-bound message.
**Engineering System Unlock:** Maintainers can improve and verify automatic commit behavior once, while each consuming repository gets the same observable workflow without carrying a forked script.
**vFinal:** A maintainer installs this repository as a commit-pinned development dependency, runs `npm run commit:auto` or `npm run commit:auto:watch` from any supported Git repository, sees repository-aware progress, and receives an exact-snapshot commit whose message uses that repository's identity and relevant work specs. The tool never pushes, rewrites history, or silently omits work.
**Primary entrypoints:** `auto-commit --once`, `auto-commit --watch`, and consumer-owned `commit:auto` npm scripts.
**Reference routing:**
- [Implementation map](references/implementation-map.md) — read **Package and consumer path** and **Repository-aware message path** before changing the package boundary.
- [Provenance](references/provenance.md) — read only when revisiting why consumers pin a Git commit or why one implementation replaces repository-local copies.

## 1) North Star — vFinal

### 1.A Journey
- **Actor:** A developer or agent operating in a Git repository with an authenticated standalone Codex CLI.
- **Entry point:** Run the repository's `npm run commit:auto` command, or keep `npm run commit:auto:watch` alive.
- **Steps:** Let changes settle → observe the timestamped phase rail and model heartbeat → receive one evidence-bound commit → inspect its subject, value lines, optional proof/scope, and repository-correct work-spec links.
- **Success:** The commit tree exactly matches the frozen snapshot described by the message, and every consumer reaches that behavior through the same pinned package rather than a local implementation.
- **Next thing they will try:** Keep working, inspect `git show`, or reuse the package in another repository.

### 1.B Experience invariants — “it is not real unless…”
- `C-001` — Installing the package exposes one executable named `auto-commit` without runtime dependency installation beyond the package itself.
- `C-002` — The executable behaves consistently from any supported repository and derives repository identity from Git truth.
- `C-003` — Consumers pin one immutable upstream commit and contain no forked runtime copy.
- `C-004` — The frozen-index safety, exact change accounting, compact message contract, and styled/plain progress modes survive extraction intact.
- `C-005` — Running the consumer command completes through its installed binary and creates the requested local commit without pushing.

### 1.C Obviousness audit
- **Assumption:** Installing a CLI means the command should be discoverable immediately. → **Implication:** `auto-commit --help` is the first-success check and documents side effects explicitly.
- **Assumption:** A shared tool may run in repositories with different names and layouts. → **Implication:** repository prefixes are inferred from the Git root and validated rather than branded as `idavoll-games`.
- **Assumption:** A Git dependency can move unless pinned. → **Implication:** consumers record an exact commit SHA, not a branch name.

### 1.D Developer experience bar
- One canonical command and one canonical implementation.
- The default one-shot path requires no flags; watch mode is an explicit advanced path.
- Help and README state plainly that the tool stages and commits all settled repository changes.
- Interactive stderr remains designed for humans; redirected stderr remains plain and stdout remains the final machine-readable commit result.

## 2) Non-Goals

- Publishing to npm, maintaining a registry release train, or creating tags in this lane.
- Push, merge, rebase, amend, reset, restore, clean, deployment, or selective-file commit composition.
- Supporting repositories that are not Git worktrees or runtimes older than the declared Node engine.
- Adding a second compatibility wrapper after consumers migrate.

## 3) Request Anchor

- **Must:** Make the current automatic commit tool standalone and push it to `git@github.com:erikhazzard/auto-commit.git`.
- **Must:** Add it as a development dependency in `idavoll-games` and `idavoll-game-platform-backend` and run it in each repository.
- **Must:** Preserve the compact commit-message format and the styled, timestamped terminal experience already accepted as the direction.
- **Interpretation:** The request names the current `idavoll-games` repository twice; until corrected, the two distinct named consumers are `idavoll-games` and `idavoll-game-platform-backend`.

## 4) Current Truth

- **Fact:** The GitHub SSH remote exists, is accessible, and contains no refs as of 2026-08-14.
- **Fact:** The current implementation is Node ESM with no third-party runtime imports and has a 34-case temporary-repository journey suite.
- **Fact:** The extracted implementation currently hardcodes `idavoll-games` in work-spec rendering and terminal branding; that cannot become the cross-repository contract.
- **Decision:** The package name is `@erikhazzard/auto-commit`, the binary name is `auto-commit`, and consumers pin the first upstream commit SHA through `git+ssh`.
- **Decision:** The package supports Node `^20.19.0 || ^22.12.0 || >=24.0.0`, covering the source repository and the backend's Node 24 runtime.

## 5) Contracts & Invariants

- `[C-001 | Must]` Installing the Git package creates `node_modules/.bin/auto-commit`; `auto-commit --help` exits zero without requiring a Git delta or Codex model call.
- `[C-002 | Must]` Runtime repository identity comes from the canonical Git worktree root basename and is used for terminal context plus each rendered `Work-Spec: <repository>/<path>` line; model output cannot supply or override that prefix.
- `[C-003 | Must]` Package runtime behavior retains the frozen base/index/tree checks, exact Luna work-stream coverage, Sol message synthesis, secret/context bounds, signal cleanup, and post-commit reconciliation of the source implementation.
- `[C-004 | Must]` Consumers use `@erikhazzard/auto-commit` as a development dependency pinned to one full upstream commit SHA and expose `commit:auto` plus `commit:auto:watch` scripts through the package binary.
- `[C-005 | Must Not]` After migration, consumers contain no executable fork or duplicate focused suite/work-spec that claims ownership of package behavior.
- `[C-006 | Must]` The package README names prerequisites, exact side effects, commands, progress/output boundaries, failure behavior, and the fact that the tool never pushes.
- `[C-007 | Failure]` Package or consumer installation failure leaves repository work intact and returns nonzero; a runtime failure never reports a commit unless Git reconciliation proves it exists.
- `[C-008 | Must Not]` Extraction may not weaken snapshot integrity, prompt-injection resistance, secret rejection, proof honesty, or the concise message shape.

## 6) Vertical-Slice Ladder to vFinal

### STANDALONE-AUTO-COMMIT__M1 — Install, run, and maintain one shared CLI — Active
- **Unlock:** A developer can run the same repository-aware automatic commit command in both confirmed consumers while maintainers own one upstream implementation.
- **Working slice:** Git dependency install → package binary → consumer repository discovery → frozen evidence/model path → repository-correct commit → consumer commit verification.
- **vFinal advance:** Completes the requested extraction and proves the installed package through both real consumer entrypoints.
- **Lasting shape:** One standalone Git repository owns source, docs, and tests; consumers own only an immutable dependency pin and npm aliases.
- **Implementation map:** Read [Package and consumer path](references/implementation-map.md#package-and-consumer-path) and [Repository-aware message path](references/implementation-map.md#repository-aware-message-path).
- **Not in this rung:** npm publication, tags, a third inferred consumer, selective commits, or service-manager installation.
- **Contracts:** C-001–C-008.
- **Material risk:** Extraction passes unit checks but the packed dependency does not expose the binary, or a consumer generates `idavoll-games` links while running elsewhere.
- **Real journey proof:** Pack and install the package in a temporary Git consumer, exercise its executable with the fake-Codex journey, then run the pushed pinned dependency through each confirmed live consumer.
- **Done when:** Focused package tests pass, a packed-install smoke passes, upstream `main` is pushed, both consumers resolve the same SHA, local duplicates are gone, and each requested live invocation produces a verified commit.

## 7) Current Motion

- **Lane state:** Standalone package proven locally; upstream push and consumer migrations remain.
- **Approval:** Erik's 2026-08-14 current-turn request authorizes creating and pushing the standalone repository, adding the development dependency, and running the commit tool in each named consumer.
- **Active rung:** `STANDALONE-AUTO-COMMIT__M1`
- **Next action:** Commit and push the proven package, then install that exact commit in both confirmed consumers.
- **Claim boundary:** Repository-generic attribution, source behavior, package contents, and the installed `.bin` entrypoint are locally proven; upstream distribution and real consumer runs are not yet proven.

## 8) Proof & Human Acceptance

- **Existing source evidence:** `npx vitest run tests/core-flow__automatic-commit.spec.js` passed 34/34 on 2026-08-14 before extraction.
- **Fresh package evidence:** `npm test` passed 35/35 on 2026-08-14, including the real temporary-Git journeys, repository-generic `Work-Spec:` rendering, and a tarball install followed by `node_modules/.bin/auto-commit --help`. `git diff --check`, Node syntax checks for every runtime file, direct `--help`, and `npm pack --dry-run` also passed; the tarball contains six intended runtime files and no runtime dependency manifest.
- **Remaining fresh evidence:** Immutable upstream ref inspection, dependency resolution in each consumer, and real `npm run commit:auto` results.
- **Blind spot:** Live Codex service latency and semantic variability remain external; the deterministic harness proves orchestration and validation, not model service speed.

## 9) Decisions & Supporting References

- **Binding decision:** 2026-08-14 / one standalone implementation plus exact-SHA Git consumers / user request and cross-repo reproducibility / reopen if the user asks for npm publication or a release channel.
- **Binding decision:** 2026-08-14 / infer repository identity from canonical Git root / prevents cross-repository link corruption without adding configuration / reopen only if a consumer needs a display identity different from its Git repository.
- **Binding decision:** 2026-08-14 / remove local runtime copies in the same migration / one-clear-path ownership and no fork drift / rollback is a forward consumer dependency change to a known upstream commit.
