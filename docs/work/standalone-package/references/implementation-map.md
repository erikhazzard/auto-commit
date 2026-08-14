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
4. Luna and Sol continue selecting only candidate work-spec paths relative to the repository root. The renderer alone prefixes validated paths as `Work-Spec: <repository>/<path>`.
5. Tests use a fixture repository whose basename is not `idavoll-games` and assert that hardcoded branding cannot leak into the resulting commit.

## Extraction-preserved runtime flow

The implementation retains the existing settled-state polling, frozen copied index, secret/context bounds, sequential Luna xhigh → Sol high structured handoff, deterministic compact renderer, pre-commit drift checks, commit-index isolation, post-commit reconciliation, signal cleanup, TTY phase rail, `NO_COLOR`, and redirected plain output. Extraction is an ownership and repository-identity change, not a rewrite of those safety contracts.

## Failure and recovery

- Pack/install failure: no consumer migration or live run is claimed.
- Invalid repository identity: fail before model invocation or commit.
- Consumer cannot resolve the pinned Git package: preserve its working tree, report the install failure, and do not fall back to a local script.
- Live run fails before commit: keep staged work and the dependency migration intact for diagnosis or retry.
- Live run reports ambiguity: inspect Git parent/tree/message; never repeat a possibly successful commit blindly.

## Proof seam

The cheapest credible seam remains the real CLI in a temporary Git repository with a fake Codex executable. A separate packed-install smoke protects the new packaging/bin contract. Finally, the user-requested live runs prove the pushed Git dependency under each consumer's real npm and Git environment.
