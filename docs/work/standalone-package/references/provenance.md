# Standalone Auto Commit — Provenance

## Request lineage

- 2026-08-13 — Erik requested a repository-owned automatic commit workflow using Luna for complete change accounting and Sol for the final message.
- 2026-08-14 — Erik required timestamped liveness, lower latency, a compact value-first message, and a much stronger terminal visual treatment.
- 2026-08-14 — Erik requested that the finished tool become a standalone repository at `git@github.com:erikhazzard/auto-commit.git`, be installed as a development dependency in the named repositories, and be run in each.

## Surviving rationale

- One upstream implementation prevents safety checks, prompts, format, and terminal presentation from drifting independently across repositories.
- An exact Git commit pin gives consumers immutable behavior before an npm release channel exists.
- Repository identity belongs to trusted Git context. Asking the model or each consumer to configure a prefix would add a failure mode and allow incorrect work-spec attribution.
- The package stays CLI-first and zero-runtime-dependency because the existing implementation already uses Node and Git primitives directly.

## Primary sources consulted

- The source implementation and 34-case journey suite in `idavoll-games` as of 2026-08-14.
- Root operating contracts in `idavoll-games` and `idavoll-game-platform-backend` for shared-checkout Git custody, Node compatibility, dependency discipline, and proof expectations.
- `git ls-remote` against the requested SSH remote, confirming it exists and is empty before the initial push.
