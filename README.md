# auto-commit

`auto-commit` turns the complete settled delta in a Git repository into one evidence-bound commit. Parallel Luna xhigh calls account for every staged change, Luna max writes the concise message, and deterministic checks ensure the committed tree is the frozen snapshot the models received.

> [!WARNING]
> This is intentionally a sweep command. It runs `git add -A` and commits **all** settled changes in the current repository. It does not select files, split workstreams into separate commits, push, or rewrite history.

## Requirements

- Node.js `^20.19.0`, `^22.12.0`, or `>=24.0.0`
- Git with a configured commit identity
- A standalone Codex CLI that supports `codex exec` and already has an authenticated `CODEX_HOME`

The CLI has no third-party runtime dependencies.

## Choose Codex authentication

By default, `auto-commit` uses the caller's existing `CODEX_HOME`. Confirm that profile before a run:

```bash
codex login status
```

For unattended runs, a dedicated API-key profile avoids coupling `gcm` to Ratatosk or another interactive Codex account. The login is a one-time setup; API usage is billed at standard API rates:

```bash
(
  set -e
  umask 077
  mkdir "$HOME/.codex-auto-commit"
  printf '%s\n' 'cli_auth_credentials_store = "file"' > "$HOME/.codex-auto-commit/config.toml"
  printenv OPENAI_API_KEY | CODEX_HOME="$HOME/.codex-auto-commit" codex login --with-api-key
  CODEX_HOME="$HOME/.codex-auto-commit" codex login status
)
export AUTO_COMMIT_CODEX_HOME="$HOME/.codex-auto-commit"
```

The setup intentionally stops if that profile directory already exists rather than overwriting it. Add only the final `export` to `.zshrc` to keep this choice across interactive shells. `AUTO_COMMIT_CODEX_HOME` affects only Codex subprocesses started by `auto-commit` and takes precedence over an inherited `CODEX_HOME`; it is not a secret. The API key is read only by the one-time login command and is then cached under the dedicated directory, so protect that directory like any other credential store. Do not put `OPENAI_API_KEY` or the cached `auth.json` in a repository, wrapper, or LaunchAgent plist. A LaunchAgent does not source `.zshrc`, so pass `AUTO_COMMIT_CODEX_HOME` in its environment separately when it should use the same profile.

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

`gcm` is a real package command, not a shell alias, so no alias is required in `.zshrc`; the optional authentication-profile export above is the only shell configuration. It is equivalent to `auto-commit --once`: both commands stage, freeze, and commit the complete settled delta. Rerun the install command to upgrade. To pin a specific revision, append `#FULL_COMMIT_SHA` to the Git URL.

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

After model work completes, the phase rail shows a `COST` row with the estimated API-equivalent USD cost for the whole sweep and a per-model breakdown. A normal run is Luna-only: Luna xhigh evidence extraction and Luna max final writing roll into the same Luna subtotal. Completed repair attempts count too, and a rare Sol fallback appears as a separate subtotal when invoked. If model validation ultimately fails after usage was reported, a warning-colored `COST` row shows the amount spent before the final error. This is an estimate, not an invoice: Codex subscription or quota billing can differ. The bundled standard API rate card is dated August 14, 2026 and uses the official per-million-token rates for [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) and [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol). Cached input receives its published rate, reasoning tokens are not double-counted because they are already part of output tokens, and the published long-context multiplier is applied separately to any request over 272K input tokens.

Non-trivial snapshots are split into as many as four size-balanced Luna xhigh evidence shards. Each shard receives a disjoint set of evidence entries, all shards run concurrently, and the runtime revalidates exact full-snapshot coverage before invoking the Luna max final writer. Small snapshots naturally use one evidence call. If one evidence response is malformed or omits assigned evidence, only that shard gets one full replacement attempt with path-aware validator feedback; successful sibling reports are retained. The final writer also gets one bounded repair attempt; only an output that remains invalid falls back once to Sol high. An invocation failure or exhausted validation leaves the staged work uncommitted.

Large sweeps are compacted before model invocation without changing the frozen Git tree. A fully removed directory containing at least 20 files becomes one digest-backed deletion entry; if the remaining evidence would still overfill the model budget, coherent path cohorts are progressively replaced by bounded status/sample/type/digest summaries. Every raw path still participates in safety checks and work-spec discovery. Recognized dependency lockfiles remain staged and are committed exactly, but their patch bodies are omitted from model context and represented as metadata-only supporting changes. There is no fixed changed-file count or model-packet-size rejection: evidence becomes more summarized as the sweep grows.

## What the message contains

Every message has one subject plus at least one `User journey`, `Developer journey`, or `Engineering unlock`. Those value lines are written for a product manager: they name the affected actor or system, the changed ability or workflow, and why the consequence matters. Specification-, plan-, documentation-, and test-only changes are framed as decisions, intended journeys, review clarity, or retained proof—not as product behavior that already shipped. Multiple distinct workstreams receive one concise aggregate line. `Proof` and `Scope` appear only when they add useful, evidence-supported information. Every rendered body field must be a complete sentence; invisible Unicode format characters and incomplete prose are rejected through the same bounded writer-repair path instead of entering Git history.

Work specs are optional. When the frozen snapshot contains a discoverable, relevant file named `work-spec.md`, it renders with the Git repository directory name and its actual repository-relative path:

```text
Work-Spec: <repository>/<path-to-work-spec.md>
```

No `Work-Spec:` line is emitted when none is discovered. A repository does not need a `docs/work` directory or any work-spec convention. Built-in discovery finds `work-spec.md` files that own changed descendants, directly changed specs under `docs/work`, and bounded `docs/work` specs that name a changed path. Other filenames and unrelated layouts are ignored without blocking the commit.

Proof language is deliberately conservative. A changed test file proves that test coverage changed, not that the test ran or passed. A message may describe a check as passing only when the frozen staged evidence contains a concrete receipt with both the command and its result. Test output that appeared earlier in the terminal is not visible to `auto-commit` unless it was recorded in a staged artifact.

## Safety and recovery

The tool freezes a copied Git index, gives every model call bounded evidence from that snapshot, checks that live `HEAD` and the real index have not moved, commits through an isolated index, and reconciles the resulting commit before reporting success. Edits made after the snapshot remain for a later sweep.

Failures return nonzero and preserve repository work. Known structured Codex failures—such as a usage limit—surface their bounded provider message without echoing the staged prompt; stderr diagnostics remain authoritative when present. A permanent validation failure in watch mode blocks that unchanged fingerprint; a changed delta re-arms the watcher. The tool never pushes, rebases, amends, resets, restores, cleans, or deletes work.

Use `--codex-bin <path>` when the first compatible standalone Codex CLI on `PATH` is not the desired executable. Run `auto-commit --help` for timing and watch options.

## Develop

```bash
npm install
npm test
npm pack --dry-run
```

The focused suite runs the real CLI and Git boundaries in temporary repositories while replacing only the paid Codex model boundary.
