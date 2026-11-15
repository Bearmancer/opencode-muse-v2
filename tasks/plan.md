# Implementation Plan: opencode-muse-v2

Source spec: SPEC-v2.md (parent issue on Bearmancer/opencode-muse-v2)
Tasks tracked in: GitHub Issues on Bearmancer/opencode-muse-v2 (ticket index below)

## Overview

Fork divergence in two independent modules plus a release pass: remove all approval/recovery-prompt machinery (Muse runs unattended, residual wire approvals auto-decided, stale turns auto-recover), add a zero-config TUI sidebar with two Muse usage meters (5h window, weekly), then ship v2.0.0 with rebranded README and swap OpenCode's plugin entry to the fork.

## Architecture Decisions

- allowAll always + minimal wire adapter for residual approval/request (once-scoped approve, else interrupt). No parking, no prompts, no verdict consumption.
- Auto-abandon stale registry entries at resolve (same effect as the old "A" answer), one-line notice; integrity checks stay fail-closed.
- userInput flow untouched (separate machinery).
- Meters: TUI-only part, `muse usage` poll 60s, `sidebar.content` slot, parser + render model as pure functions (testable without a TUI).
- Plugin id/package name unchanged; repo/README brand opencode-muse-v2; version 2.0.0.
- Removal follows deprecation-and-migration: replacement first, then en-masse contract (code+tests+docs), grep zero-reference proof.

## Autopilot defaults (owner verification pending)

- D1: residual approvals auto-decided once-scoped; never persistent policy.
- D2: recovery prompts → auto-abandon + notice.
- D3: userInput kept.
- D4: meters fixed 60s poll, two lines + bars, no config/commands/toasts.
- D5: id/package name kept; brand + version 2.0.0.
- D6: config entry tries `github:` specifier; fallback `file:` to a fork clone.
- D7: constraints floor + types + suite ratchet + external live probe (non-interactive default).
- D8: one v2 PR on the fork; upstream keeps only PR #53.
- D9: cross-model doubt review skipped (non-interactive); oracle single-model review used.

## Task List (ticket index)

### Phase 1: no-approvals
- [ ] T1: Unattended Muse sessions — allowAll + residual approval auto-decide + approval UX removal (issue #2)
- [ ] T2: Auto-recovery — stale entries abandon automatically, recovery UX removal (issue #4, blocked by #2)

### Checkpoint: no-approvals
- [ ] Build clean; suite ratchet holds; live fixed-token turn under DEFAULT profile: zero prompts

### Phase 2: usage-meters
- [ ] T3: Two sidebar meters from `muse usage` (parser + render model + TUI part + build wiring) — issue #3, independent

### Checkpoint: meters
- [ ] Parser tests green against real CLI output; TUI entry builds and imports

### Phase 3: release
- [ ] T4: v2.0.0 — version, README rebrand, docs/spec/CONSTRAINTS committed, config swap to fork, live verification (issue #5, blocked by #2, #4, #3)

### Checkpoint: complete
- [ ] All SPEC-v2 success criteria evidenced; doubt review reconciled; PR filed and merged on fork; OpenCode runs the fork

## Verification plan (evidence path per claim)

| Claim | Evidence | Owner |
|---|---|---|
| allowAll on every muse session | fake-host session/start capture test | T1 |
| residual approvals decided silently | fake-host approval/request test (approve + interrupt paths) | T1 |
| no approval UX remains | grep zero-reference list + suite accounting | T1/T2 |
| stale turns auto-recover | registry-seeded resolve test | T2 |
| turns complete unattended (real) | live `opencode run` fixed-token under default profile, verbatim | T1 checkpoint |
| meters parse real CLI | unit tests + live `muse usage` parse output | T3 |
| meters render in TUI | built ./tui import smoke + slot registration; visual check deferred to owner if headless capture unavailable | T3/T4 |
| fork loads in OpenCode | `opencode models` rows + live turn via fork entry | T4 |

Limitations: TUI visual appearance cannot be screenshotted headlessly on this host with available tools; render-model output + slot registration + owner visual check is the fallback (recorded).

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| allowAll under default profile still parks protected-write approvals | Med | wire adapter decides them; live probe covers |
| auto-abandon drops a turn that actually ran | Med | same semantics as old "A"; notice states effects still apply |
| TUI JSX build wiring (solid) fights tsc | Med | build probe first in T3; fallback non-JSX render functions |
| `github:` plugin specifier unsupported | Low | D6 fallback file: entry; recorded |
| suite ratchet noise (Windows flakes) | Low | W1 exception; compare failure names |

## Open Questions

- None blocking; all defaulted (D1–D9) for owner verification.
