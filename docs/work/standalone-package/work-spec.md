# WORK SPEC — Standalone Auto Commit

**Purpose:** Give every repository one installable `auto-commit` command that turns a settled Git delta into a safe forward commit with a concise, evidence-bound message, whether invoked directly or by bounded personal automation.
**Engineering System Unlock:** Maintainers improve and verify automatic commit behavior once; parallel evidence extraction reduces the dominant wait, and one quiet local scheduler keeps Idavoll repositories moving without per-repository script forks.
**vFinal:** A maintainer installs one commit-pinned package, types `gcm` from any supported Git repository or relies on a ten-minute macOS LaunchAgent across the four canonical Idavoll repositories, sees repository-aware parallel progress only when work exists, and receives an exact-snapshot commit whose message uses that repository's identity and relevant work specs. The tool never pushes, rewrites history, silently omits work, or starts model calls for a clean scheduled repository.
**Primary entrypoints:** `auto-commit --once`, `auto-commit --watch`, consumer-owned `commit:auto` npm scripts, shell alias `gcm`, and LaunchAgent `com.erikhazzard.auto-commit`.
**Reference routing:**
- [Implementation map](references/implementation-map.md) — read **Parallel Luna evidence flow** before changing model orchestration and **macOS personal automation** before changing the installed scheduler.
- [Provenance](references/provenance.md) — read only when revisiting why consumers pin a Git commit or why one implementation replaces repository-local copies.

## 1) North Star — vFinal

### 1.A Journey
- **Actor:** A developer or agent operating in an Idavoll Git repository with an authenticated standalone Codex CLI.
- **Entry point:** Type `gcm`, run the repository npm script, keep watch mode alive, or let the ten-minute LaunchAgent notice a dirty canonical repository.
- **Steps:** Let changes settle → start or automatically receive one run only when dirty → observe bounded Luna shards and their liveness → receive one evidence-bound commit → inspect its value-first message and repository-correct work-spec links.
- **Success:** The commit tree exactly matches the frozen snapshot, every changed entry was owned by exactly one Luna shard and one merged workstream, clean scheduled repositories incurred no model call, and every entrypoint reaches the same pinned implementation.
- **Next thing they will try:** Keep working, inspect `git show`, let the next scheduled check stay quiet, or invoke `gcm` in another repository.

### 1.B Experience invariants — “it is not real unless…”
- `C-001` — Installing the package exposes one executable named `auto-commit` without runtime dependency installation beyond the package itself.
- `C-002` — The executable behaves consistently from any supported repository and derives repository identity from Git truth.
- `C-003` — Consumers pin one immutable upstream commit and contain no forked runtime copy.
- `C-004` — The frozen-index safety, exact change accounting, compact message contract, and styled/plain progress modes survive extraction intact.
- `C-005` — Running the consumer command completes through its installed binary and creates the requested local commit without pushing.
- `C-009` — Non-trivial snapshots use bounded parallel Luna shards while deterministic full-snapshot validation remains the authority.
- `C-010` — `gcm` is globally discoverable and invokes the same one-shot binary without duplicating staging logic.
- `C-011` — The macOS schedule checks four explicit Idavoll repositories every ten minutes and invokes no model/tool run for a clean repository.

### 1.C Obviousness audit
- **Assumption:** Installing a CLI means the command should be discoverable immediately. → **Implication:** `auto-commit --help` is the first-success check and documents side effects explicitly.
- **Assumption:** A shared tool may run in repositories with different names and layouts. → **Implication:** repository prefixes are inferred from the Git root and validated rather than branded as `idavoll-games`.
- **Assumption:** A Git dependency can move unless pinned. → **Implication:** consumers record an exact commit SHA, not a branch name.
- **Assumption:** Parallel agents may finish or fail out of order. → **Implication:** shard ownership is deterministic, results are re-keyed and merged by the runtime, and one failure cancels sibling model processes before Sol can run.
- **Assumption:** A background scheduler should be invisible when there is nothing to do. → **Implication:** a repository dirtiness check happens before `auto-commit` is invoked, logs live outside repositories, and repositories run sequentially.

### 1.D Developer experience bar
- One canonical command and one canonical implementation.
- The default one-shot path requires no flags; watch mode is an explicit advanced path.
- Help and README state plainly that the tool stages and commits all settled repository changes.
- Interactive stderr remains designed for humans; redirected stderr remains plain and stdout remains the final machine-readable commit result.
- Parallel progress names each shard and retains time-based liveness without turning redirected output into a dashboard.
- `gcm` has no hidden mode: it means the documented one-shot all-changes sweep.

## 2) Non-Goals

- Publishing to npm, maintaining a registry release train, or creating tags in this lane.
- Push, merge, rebase, amend, reset, restore, clean, deployment, or selective-file commit composition.
- Supporting repositories that are not Git worktrees or runtimes older than the declared Node engine.
- Linux/systemd scheduling, cloud automation, automatic push, or installing a scheduler for repositories outside the four canonical local Idavoll checkouts.
- Running scheduled repositories concurrently; sequential execution avoids multiplying Codex load and each repository lock remains authoritative.

## 3) Request Anchor

- **Must:** Make the current automatic commit tool standalone and push it to `git@github.com:erikhazzard/auto-commit.git`.
- **Must:** Add it as a development dependency in `idavoll-games` and `idavoll-game-platform-backend` and run it in each repository.
- **Must:** Preserve the compact commit-message format and the styled, timestamped terminal experience already accepted as the direction.
- **Must:** Split Luna across multiple parallel agents, each receiving a different slice of the frozen changes, without weakening complete accounting.
- **Must:** Install a global `gcm` alias in `~/.zshrc` so typing it stages and runs the tool through the canonical one-shot path.
- **Must:** Install a macOS background job that checks the Idavoll repositories every ten minutes, runs the tool only for dirty repositories, and does nothing for clean repositories.
- **Interpretation:** The request names the current `idavoll-games` repository twice; until corrected, the two distinct named consumers are `idavoll-games` and `idavoll-game-platform-backend`.

## 4) Current Truth

- **Fact:** Commit `437c366a77d2c777478f520a0100996957b70a38` is pushed to the GitHub SSH remote; both confirmed consumers resolve it as a development dependency and removed the local fork.
- **Fact:** Real installed-package runs committed the backend at `2038ae4f618f` and `idavoll-games` at `145daf6d5a33`, with correct repository prefixes and no push.
- **Fact:** Luna is the dominant latency: 15 backend changes took 2m19s in Luna plus 25s in Sol; 40 game changes took 3m44s in Luna plus 29s in Sol.
- **Fact:** The package is Node ESM with no third-party runtime dependencies; the 0.2.0 candidate has a 36-case temporary-repository journey suite.
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
- `[C-009 | Must]` A snapshot with enough changed entries is partitioned into at most four disjoint, size-balanced Luna packets; every change ID appears in exactly one shard, each shard receives only its assigned patch detail plus relevant bounded context, and the merged report is validated once more against the full manifest before Sol runs.
- `[C-010 | Failure]` If any Luna shard fails, times out, returns invalid coverage, or is interrupted, sibling shard processes are cancelled, Sol is not invoked, no commit is reported, and the frozen/staged work remains recoverable for the operator or next scheduled check.
- `[C-011 | Must]` The installed `gcm` shell alias resolves to the globally installed, full-SHA package and invokes `auto-commit --once`; the tool itself remains the sole staging owner so alias and npm entrypoints share identical snapshot semantics.
- `[C-012 | Must]` LaunchAgent `com.erikhazzard.auto-commit` runs at a 600-second interval over `idavoll-games`, `idavoll-game-platform-backend`, `idavoll-frontend`, and `idavoll-studio-frontend`; it tests Git dirtiness before invocation, runs dirty repositories sequentially through the absolute global binary, emits bounded user-library logs, and relies on the per-repository lock to reject overlap.

## 6) Vertical-Slice Ladder to vFinal

### STANDALONE-AUTO-COMMIT__M1 — Install, run, and maintain one shared CLI — Complete
- **Unlock / surviving result:** One zero-runtime-dependency package is pushed, exact-SHA installed in both confirmed consumers, and proven through real repository-aware commits `2038ae4f618f` and `145daf6d5a33`; `idavoll-games` no longer owns a fork.
- **Regenerate / inspect:** `npm test`, `npm pack --dry-run`, and each consumer's `npm run commit:auto`.
- **Claim boundary:** The extracted sequential model path is proven; those runs establish current service latency but not a stable wall-clock budget.

### STANDALONE-AUTO-COMMIT__M2 — Parallel evidence and quiet personal automation — Active
- **Unlock:** A developer gets materially shorter evidence waits on non-trivial sweeps, can type `gcm` anywhere, and can leave four canonical Idavoll repositories under a quiet ten-minute local commit cadence.
- **Working slice:** Dirty Git snapshot → deterministic evidence shards → concurrent Luna processes → full-manifest merge validation → Sol/commit; plus pinned global install → `gcm`; plus LaunchAgent dirty check → sequential per-repository one-shot run → user-library logs.
- **vFinal advance:** Adds the requested latency and unattended operator journeys without changing commit format, Git authority, or push behavior.
- **Experience bar:** Parallel phases remain legible by shard; clean scheduled checks produce no model process or repository noise; failed shards/scheduled runs are diagnosable from stable exit codes and log paths.
- **Lasting shape:** Sharding is internal to the one CLI; personal shell/launchd configuration calls the public binary and contains no copy of commit logic.
- **Implementation map:** Read [Parallel Luna evidence flow](references/implementation-map.md#parallel-luna-evidence-flow) and [macOS personal automation](references/implementation-map.md#macos-personal-automation).
- **Not in this rung:** Parallel repository scheduling, npm publication, Linux services, automatic push, or a generic cross-platform service installer.
- **Contracts:** C-001–C-012.
- **Material risk:** Partial/out-of-order shard results omit or duplicate a change, sibling Codex processes leak after failure, or launchd runs a stale binary/environment and silently stops committing.
- **Real journey proof:** The packed CLI commits a multi-shard temporary repository through the fake-Codex boundary with exact global coverage; a real run shows concurrent named Luna shards; a new shell resolves `gcm`; and the loaded LaunchAgent's program can be invoked against a clean fixture without starting `auto-commit`, then against a dirty fixture with one recorded invocation. Source-only partition tests or a plist syntax check do not count.
- **Done when:** Multi-shard coverage/cancellation/progress guards pass, the new full-SHA package is pushed and installed globally/repinned, `gcm` resolves in a fresh zsh, the LaunchAgent is loaded at 600 seconds for the four explicit repositories, clean checks skip, dirty checks invoke once, and status/log locations are reported.

## 7) Current Motion

- **Lane state:** Active; extraction is complete and parallel/personal automation is implementing.
- **Approval:** Erik's 2026-08-14 requests authorize the standalone push and consumer runs, then bounded parallel Luna extraction, global `gcm`, and a ten-minute local macOS job over the Idavoll repositories.
- **Active rung:** `STANDALONE-AUTO-COMMIT__M2`
- **Next action:** Run the 0.2.0 candidate through its own real multi-shard CLI, then push and pin that exact commit before installing the personal shell and launchd entrypoints.
- **Claim boundary:** The pushed sequential package and both consumer runs are proven; deterministic multi-shard coverage/cancellation is proven through the focused journey suite, while a live parallel model run, global shell availability, and launchd scheduling are not yet proven.

## 8) Proof & Human Acceptance

- **Existing source evidence:** `npx vitest run tests/core-flow__automatic-commit.spec.js` passed 34/34 on 2026-08-14 before extraction.
- **Fresh package evidence:** `npm test` passed 35/35 on 2026-08-14, including the real temporary-Git journeys, repository-generic `Work-Spec:` rendering, and a tarball install followed by `node_modules/.bin/auto-commit --help`. `git diff --check`, Node syntax checks for every runtime file, direct `--help`, and `npm pack --dry-run` also passed; the tarball contains six intended runtime files and no runtime dependency manifest.
- **Fresh M2 candidate evidence:** `npm test` passed 36/36 on 2026-08-14, including four concurrent disjoint Luna shards with exact 40-change coverage, named shard progress, deterministic merge validation, and sibling-process cancellation with no Sol call or commit after a forced shard failure. Node syntax checks, `git diff --check`, direct `--help`, and `npm pack --dry-run` passed; the 0.2.0 tarball contains seven intended runtime files and no runtime dependencies.
- **Completed distribution evidence:** Remote `main` resolves `437c366a77d2c777478f520a0100996957b70a38`; both consumer manifests and lockfiles resolve that full SHA; backend run `2038ae4f618f` covered 15 changes and left a clean tree; game run `145daf6d5a33` covered 40 frozen changes while later edits remained eligible for the next sweep.
- **Remaining fresh evidence:** Multi-shard suite/run, new immutable upstream ref, global alias resolution, and loaded clean-skip/dirty-run LaunchAgent behavior.
- **Blind spot:** Live Codex service latency and semantic variability remain external; the deterministic harness proves orchestration and validation, not model service speed.

## 9) Decisions & Supporting References

- **Binding decision:** 2026-08-14 / one standalone implementation plus exact-SHA Git consumers / user request and cross-repo reproducibility / reopen if the user asks for npm publication or a release channel.
- **Binding decision:** 2026-08-14 / infer repository identity from canonical Git root / prevents cross-repository link corruption without adding configuration / reopen only if a consumer needs a display identity different from its Git repository.
- **Binding decision:** 2026-08-14 / remove local runtime copies in the same migration / one-clear-path ownership and no fork drift / rollback is a forward consumer dependency change to a known upstream commit.
- **Binding decision:** 2026-08-14 / use at most four deterministic, size-balanced Luna shards for non-trivial frozen snapshots, then revalidate their merged output against the full packet before Sol / directly targets measured Luna latency while keeping deterministic code—not a model—as coverage authority / reopen if live latency or output quality regresses materially.
- **Binding decision:** 2026-08-14 / globally install the exact pushed Git commit; `gcm` delegates to `auto-commit --once` rather than separately running `git add`; one canonical staging owner preserves snapshot semantics / user request and one-clear-path design / reopen if the public CLI gains a different canonical one-shot command.
- **Binding decision:** 2026-08-14 / one user LaunchAgent checks the four canonical Idavoll checkouts sequentially every 600 seconds and skips clean repositories before invoking the tool / avoids four schedulers, duplicate model load, and clean no-op noise / reopen when the canonical local repository set changes.
