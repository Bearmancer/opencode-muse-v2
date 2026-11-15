# Constraints

Last reviewed: 2026-11-15 by autopilot (deepwork; non-interactive — floor applied per constraint-driven-development, numbered dimensions flagged for owner verification)

## Floor (always enforced)

- No new suppression comments: `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, `# noqa`
- No unimplemented stubs: `throw new Error("Not implemented")`, empty `catch {}` without a documented reason
- No skipped or deleted tests without a reason in the commit message (removal of approval/recovery machinery deletes their tests deliberately — reason: feature removed, spec SPEC-v2.md)
- No secrets in source; never read or log Muse credentials/config from plugin code
- This file does not get weakened to make a change pass

## Enforced with numbers

| Dimension | Rule | Checked by | Runs at |
|-----------|------|-----------|---------|
| Types | Zero type errors (strict) | `bun run build` (tsc -p tsconfig.json) | every task end |
| Suite | No new failures vs baseline | `bun test ./test/run.ts` | every task end |
| External | Real `muse serve` turn completes with zero approval prompts and zero recovery prompts | live probe (test/probes or opencode run) | before PR |
| Floor | Diff-scoped guard | reviewer checklist at PR (grep for suppressions/stubs/skips) | PR |

Baseline (Windows host, 2026-11-15): 415 pass / 3 skip / 7 pre-existing failures (SessionRegistry x2, WorkspaceLock, PDF staging x2, host-config symlink, provider-list smoke — POSIX assumptions). Ratchet: failure set must not grow; names must match or be explained.

## Measured, not yet enforced

| Metric | Today | Direction |
|--------|-------|-----------|
| Suite pass count | 415 | must not fall (removed-feature tests subtracted with reason) |
| Plugin source size | approval machinery removed | must shrink in v2 |

## Exceptions

| ID | Rule | Path | Reason | Owner | Expires |
|----|------|------|--------|-------|---------|
| W1 | 7 pre-existing suite failures | test/unit/session-registry, workspace-lock, pdf-staging, host-config, provider-list-smoke | POSIX mode-bit/symlink/XDG assumptions on Windows; pre-date v2 | Lance | 2027-02-15 |
