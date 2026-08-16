# Standalone Auto Commit — Implementation Map

This file owns adaptive engineering detail only. The work spec owns product commitments and completion truth.

## Package and consumer path

1. The standalone repository owns `bin/auto-commit.js`, semantically named source modules, the focused temporary-Git journey suite, and public usage documentation.
2. `package.json` maps the stable `auto-commit` binary directly to the executable entrypoint and ships only source, binary, README, and package metadata.
3. `npm pack` is the distribution boundary. A temporary consumer installs the produced tarball and invokes `node_modules/.bin/auto-commit --help`; the fake-Codex journey exercises behavior without external model nondeterminism.
4. The first proven upstream commit is pushed to `origin/main`. Consumers install `git+ssh://git@github.com/erikhazzard/auto-commit.git#<full-sha>` as a development dependency and expose `commit:auto` / `commit:auto:watch` aliases.
5. The `idavoll-games` local runtime, package-owned test, and old package work-spec bundle are deleted in the same consumer migration. The backend gains no local copy.
6. Each live consumer invocation intentionally stages and commits its complete settled delta. Verification reads the resulting parent, tree, dependency pin, binary resolution, and message; the tool itself never pushes a consumer.

## Repository-aware message path

1. Resolve the canonical repository root with `git rev-parse --show-toplevel` before snapshot construction.
2. Derive one bounded repository name from the root basename. Reject unusable names instead of accepting model-supplied identity.
3. Include the repository name as trusted runtime context for terminal presentation and deterministic message rendering, not as changed-text/model evidence.
4. The Luna evidence pass and final writer select only candidate work-spec paths relative to the repository root. The renderer alone prefixes validated paths as `Work-Spec: <repository>/<path>`.
5. Tests use a fixture repository whose basename is not `idavoll-games` and assert that hardcoded branding cannot leak into the resulting commit.

## Extraction-preserved runtime flow

The implementation retains the existing settled-state polling, frozen copied index, secret/context bounds, Luna xhigh evidence → Luna max writing structured handoff, deterministic compact renderer, pre-commit drift checks, commit-index isolation, post-commit reconciliation, signal cleanup, TTY phase rail, `NO_COLOR`, and redirected plain output. Luna max receives one bounded repair; only two repairable invalid messages unlock one Sol high fallback. Parallel Luna changes evidence ownership and timing, not those safety contracts. `AUTO_COMMIT_CODEX_HOME` optionally selects a tool-only cached auth profile; the child environment never receives `OPENAI_API_KEY`.

## Parallel Luna evidence flow

1. Read and safety-check every raw change from the frozen index, then map it deterministically into the evidence manifest. Keep ordinary changes one-to-one while the bounded manifest permits; collapse a complete removed directory subtree of at least 20 files first, then progressively collapse coherent path cohorts whenever entry or serialized-byte pressure remains. Each summary retains status counts, boundary samples, file types, aggregate sizes, and a deterministic path/status digest. Keep recognized dependency lockfiles and blobs above the detailed-evidence budget metadata-only. Stream every omitted OID retained in the frozen tree through one bounded `git cat-file --batch` parser, scanning raw bytes with cross-chunk carry and resetting state at object boundaries; blob size never becomes a commit-eligibility gate. Omitted deleted base blobs reach neither model nor commit. Work-spec discovery and agent ownership continue to use raw paths before mapping relationships to final evidence IDs, while oversized context documents are incrementally hashed and UTF-8-validated with only bounded head/tail excerpts retained.
2. Keep a compact full-evidence-manifest overview in every shard so paths reveal cross-file relationships, but assign each evidence unit's detailed patch and required context to exactly one shard. Choose one shard for small deltas and at most four for non-trivial deltas; greedily balance bounded evidence bytes rather than raw file count.
3. Start every Luna shard concurrently with unique schema/output paths and a shared abort controller linked to the caller signal. Terminal events use `LUNA 1/N` labels; redirected logs retain full timestamped text.
4. Validate each result against only its assigned manifest, deterministically replace model-chosen stream IDs with globally unique shard/stream IDs, concatenate results, then run the existing Luna validator again against the complete packet. The Luna max writer—and the rare Sol fallback—see only this fully validated merged report.
5. On the first shard failure, abort siblings and wait for all child termination before surfacing the original failure. No correction retry or partial report crosses into final writing.
6. Preserve a single-Luna path only as the natural result of a one-shard partition, not as a separate implementation or flag.

## macOS personal automation

1. Install the package globally from the exact pushed Git SHA. The package remains the only Git/model implementation.
2. Expose `gcm` through the package's `bin` map. Do not add a shell alias or prepend a second `git add -A`; both global command names reach the same one-shot CLI, which stages and freezes once under its own authority.
3. Install `~/.local/bin/auto-commit-idavoll-repositories`, a small user-owned scheduler adapter with four explicit canonical repository paths. It checks `git status --porcelain=v1 --untracked-files=all`; clean output returns without invoking `auto-commit`, while dirty repositories run sequentially through the absolute global binary.
4. Install `~/Library/LaunchAgents/com.erikhazzard.auto-commit.plist` with `StartInterval=600`, an explicit launchd-safe PATH/auth-profile environment, no `RunAtLoad`, and stdout/stderr under `~/Library/Logs/auto-commit/`. When a dedicated profile is selected, pass only `AUTO_COMMIT_CODEX_HOME`; never place the API key in the plist.
5. Load with `launchctl bootstrap gui/<uid> ...`; inspect via `launchctl print`. The job itself never pushes and per-repository locks remain the overlap authority.
6. Prove the adapter with temporary clean/dirty repositories and a recording fake binary before loading it against real repositories. A clean fixture must produce zero recorded invocations; a dirty fixture exactly one.

## Failure and recovery

- Pack/install failure: no consumer migration or live run is claimed.
- Invalid repository identity: fail before model invocation or commit.
- Consumer cannot resolve the pinned Git package: preserve its working tree, report the install failure, and do not fall back to a local script.
- Live run fails before commit: keep staged work and the dependency migration intact for diagnosis or retry. Prefer a bounded known structured Codex failure message/code from stdout when stderr is empty; never render an entire event because it may contain staged prompt context.
- Live run reports ambiguity: inspect Git parent/tree/message; never repeat a possibly successful commit blindly.

## Proof seam

The cheapest credible seam remains the real CLI in a temporary Git repository with a fake Codex executable. A separate packed-install smoke protects the new packaging/bin contract. Finally, the user-requested live runs prove the pushed Git dependency under each consumer's real npm and Git environment.
