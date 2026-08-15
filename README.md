# auto-commit

`auto-commit` turns the complete settled delta in a Git repository into one evidence-bound commit. Bounded parallel Luna calls account for every staged change, Sol writes the concise message, and deterministic checks ensure the committed tree is the frozen snapshot the models received.

> [!WARNING]
> This is intentionally a sweep command. It runs `git add -A` and commits **all** settled changes in the current repository. It does not select files, split workstreams into separate commits, push, or rewrite history.

## Requirements

- Node.js `^20.19.0`, `^22.12.0`, or `>=24.0.0`
- Git with a configured commit identity
- A standalone Codex CLI that supports `codex exec` and already has an authenticated `CODEX_HOME`

The CLI has no third-party runtime dependencies.

## Install globally as `gcm`

Install the current Git revision once to make `gcm` available in any repository and shell:

```bash
npm install --global --allow-git=root 'git+ssh://git@github.com/erikhazzard/auto-commit.git'
gcm --help
```

Then run a sweep from any Git repository:

```bash
gcm
```

`gcm` is a real package command, not a shell alias, so `.zshrc` changes are unnecessary. It is equivalent to `auto-commit --once`: both commands stage, freeze, and commit the complete settled delta. Rerun the install command to upgrade. To pin a specific revision, append `#FULL_COMMIT_SHA` to the Git URL.

## Install in a repository

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

After model work completes, the phase rail shows a `COST` row with the estimated API-equivalent USD cost for the whole sweep and a Luna/Sol breakdown. Completed repair attempts count too. If model validation ultimately fails after usage was reported, a warning-colored `COST` row shows the amount spent before the final error. This is an estimate, not an invoice: Codex subscription or quota billing can differ. The bundled standard API rate card is dated August 14, 2026 and uses the official per-million-token rates for [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) and [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol). Cached input receives its published rate, reasoning tokens are not double-counted because they are already part of output tokens, and the published long-context multiplier is applied separately to any request over 272K input tokens.

Non-trivial snapshots are split into as many as four size-balanced Luna shards. Each shard receives a disjoint set of evidence entries, all shards run concurrently, and the runtime revalidates exact full-snapshot coverage before invoking Sol. Small snapshots naturally use one Luna call. If one Luna response is malformed or omits assigned evidence, only that shard gets one full replacement attempt with path-aware validator feedback; successful sibling reports are retained. An invocation failure or a second invalid response cancels unfinished siblings and leaves the staged work uncommitted.

Large sweeps are compacted before model invocation without changing the frozen Git tree. A fully removed directory containing at least 20 files becomes one digest-backed deletion entry; if the remaining evidence would still overfill the model budget, coherent path cohorts are progressively replaced by bounded status/sample/type/digest summaries. Every raw path still participates in safety checks and work-spec discovery. Recognized dependency lockfiles remain staged and are committed exactly, but their patch bodies are omitted from model context and represented as metadata-only supporting changes. There is no fixed changed-file count or model-packet-size rejection: evidence becomes more summarized as the sweep grows.

## What the message contains

Every message has one subject plus at least one `User journey`, `Developer journey`, or `Engineering unlock`. Multiple distinct workstreams receive one concise aggregate line. `Proof` and `Scope` appear only when they add useful, evidence-supported information.

Work specs are optional. When the frozen snapshot contains a discoverable, relevant file named `work-spec.md`, it renders with the Git repository directory name and its actual repository-relative path:

```text
Work-Spec: <repository>/<path-to-work-spec.md>
```

No `Work-Spec:` line is emitted when none is discovered. A repository does not need a `docs/work` directory or any work-spec convention. Built-in discovery finds `work-spec.md` files that own changed descendants, directly changed specs under `docs/work`, and bounded `docs/work` specs that name a changed path. Other filenames and unrelated layouts are ignored without blocking the commit.

Proof language is deliberately conservative. A changed test file proves that test coverage changed, not that the test ran or passed. A message may describe a check as passing only when the frozen staged evidence contains a concrete receipt with both the command and its result. Test output that appeared earlier in the terminal is not visible to `auto-commit` unless it was recorded in a staged artifact.

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
