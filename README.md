# auto-commit

`auto-commit` turns the complete settled delta in a Git repository into one evidence-bound commit. Luna accounts for every staged change, Sol writes the concise message, and deterministic checks ensure the committed tree is the frozen snapshot both models received.

> [!WARNING]
> This is intentionally a sweep command. It runs `git add -A` and commits **all** settled changes in the current repository. It does not select files, split workstreams into separate commits, push, or rewrite history.

## Requirements

- Node.js `^20.19.0`, `^22.12.0`, or `>=24.0.0`
- Git with a configured commit identity
- A standalone Codex CLI that supports `codex exec` and already has an authenticated `CODEX_HOME`

The CLI has no third-party runtime dependencies.

## Install from Git

Install the repository as a development dependency over SSH. Consumer repositories should append `#` plus a full upstream commit SHA to the Git URL so installs remain immutable:

```text
git+ssh://git@github.com/erikhazzard/auto-commit.git#FULL_COMMIT_SHA
```

Expose the stable binary through repository-owned scripts:

```json
{
  "scripts": {
    "commit:auto": "auto-commit --once",
    "commit:auto:watch": "auto-commit --watch"
  }
}
```

Confirm the installed command before its first write:

```bash
npx auto-commit --help
```

## Use

Run one sweep:

```bash
npm run commit:auto
```

Keep watching for settled deltas:

```bash
npm run commit:auto:watch
```

Watch mode runs in the foreground, waits for a quiet change window, responds to `SIGINT` and `SIGTERM`, and can be supervised by the caller. Use `NO_COLOR=1` when ANSI color is undesirable.

Interactive progress is written to stderr as a timestamped phase rail. Redirected stderr degrades to timestamped plain text. A successful one-shot invocation writes the final commit identity to stdout.

## What the message contains

Every message has one subject plus at least one `User journey`, `Developer journey`, or `Engineering unlock`. Multiple distinct workstreams receive one concise aggregate line. `Proof` and `Scope` appear only when they add useful, evidence-supported information. Relevant specs render as repository-aware links:

```text
Work-Spec: repository-name/docs/work/example/work-spec.md
```

Changed tests are not described as passing unless the staged evidence contains an explicit execution receipt.

## Safety and recovery

The tool freezes a copied Git index, gives both model calls bounded evidence from that snapshot, checks that live `HEAD` and the real index have not moved, commits through an isolated index, and reconciles the resulting commit before reporting success. Edits made after the snapshot remain for a later sweep.

Failures return nonzero and preserve repository work. A permanent validation failure in watch mode blocks that unchanged fingerprint; a changed delta re-arms the watcher. The tool never pushes, rebases, amends, resets, restores, cleans, or deletes work.

Use `--codex-bin <path>` when the first compatible standalone Codex CLI on `PATH` is not the desired executable. Run `auto-commit --help` for timing and watch options.

## Develop

```bash
npm install
npm test
npm pack --dry-run
```

The focused suite runs the real CLI and Git boundaries in temporary repositories while replacing only the paid Codex model boundary.
