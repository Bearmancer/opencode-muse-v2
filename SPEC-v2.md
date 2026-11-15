# Spec: opencode-muse-v2 — V2 (no-approvals + usage-meters)

Status: approved-by-autopilot (deepwork; owner verification pending)
Tracker: GitHub Issues on Bearmancer/opencode-muse-v2 (this spec is the parent issue; tickets are sub-issues)

## Capability Map

| Module id | Responsibility | Depends on |
|---|---|---|
| no-approvals | Remove approval + recovery-prompt machinery; Muse runs without asking; stale turns auto-recover | — |
| usage-meters | TUI sidebar: 5h-window and weekly Muse usage, two meters, zero configuration | — |

Build order: no-approvals → usage-meters → release (v2.0.0 branding, README, config swap). The two modules are independent; no-approvals goes first because it simplifies the session flow the meters coexist with.

## Problem Statement

The owner runs Muse models through OpenCode via the opencode-muse bridge. Two friction classes make it unusable for real work:

1. **Approval interruptions.** Every network destination and shell command parks the turn behind a conversational approval prompt; even with the 1.1.0 fixes (informative subjects, `host-default` opt-out) the owner still wants zero approval interaction in their own fork. A stuck prior turn additionally raises a "Recovery needed — reply A to abandon" prompt that blocks retries (observed: `turn/start` unknown outcome, retry attempt 4).
2. **No usage visibility.** The Muse subscription has a 5-hour window and a weekly allowance (`muse usage`: `Window: 14% used, resets in 3h 57m`, `Weekly: 93% used, resets in 20h 25m`). The owner hit 93% weekly without noticing. OpenCode Quota shows meters for other providers but not Muse; its configurability is noise for this use case.

## Solution

In the owner's fork (opencode-muse-v2, version 2.0.0):

1. **no-approvals:** Muse sessions always run with hardcoded `approvalMode: "allowAll"` (both backends; no knob, no conditional). Any residual wire `approval/request` is auto-approved with the first offered approve choice — no selection/scope logic, no reject or interrupt pathing. Any residual `userInput/request` is auto-cancelled. No parking, no prompts, no verdict/answer consumption; every user message runs as a turn. The recovery-choice prompt is replaced by automatic abandonment of stale registry entries (the same effect as answering "A" today). All conversational approval/userInput/recovery UX code, tests, and docs are removed en masse (deprecation-and-migration: replacement first, then remove code + tests + docs, verify zero references).
2. **usage-meters:** a TUI part (`./tui` export) polls the official `muse usage` CLI every 60 seconds and renders exactly two meters in the `sidebar.content` slot: 5h window and weekly, each with percent used, a simple bar, and reset time. No settings, no commands, no toasts, no options.

## User Stories

1. As the owner, I want Muse turns to run without approval prompts, so that research and coding tasks complete unattended.
2. As the owner, I want a previously authorized destination to never re-prompt, so that long tasks don't stall on repeat fetches.
3. As the owner, I want residual wire approvals auto-decided with the narrowest once-grant, so that the protocol stays valid without creating persistent policy.
4. As the owner, I want a stuck prior turn to auto-recover, so that retries proceed without a recovery questionnaire.
5. As the owner, I want my messages to always run as turns, so that no text is ever eaten as a verdict.
6. As the owner, I want the approval/recovery code gone rather than disabled, so that the fork carries no dead machinery.
7. As the owner, I want residual Muse questions auto-cancelled, so that no questionnaire ever blocks a turn (owner directive: no ceremony/hops).
8. As the owner, I want two sidebar meters (5h window, weekly), so that I can see subscription pressure at a glance.
9. As the owner, I want each meter to show percent used and reset time, so that I know when pressure relief arrives.
10. As the owner, I want a simple visual bar per meter, so that pressure is readable without parsing numbers.
11. As the owner, I want the meters to refresh automatically, so that they stay current without action.
12. As the owner, I want zero configuration for the meters, so that there is nothing to tune or break.
13. As the owner, I want the meters to degrade to a quiet placeholder when `muse usage` fails, so that a CLI hiccup never spams errors.
14. As the owner, I want the meters to use the official CLI only, so that credentials stay inside Muse.
15. As the owner, I want the plugin to load from our GitHub fork, so that the installed code is the fork's code.
16. As the owner, I want version 2.0.0 and a README that states the fork's posture, so that the divergence from upstream is explicit.
17. As the owner, I want the existing turn/session/recovery-integrity behavior otherwise unchanged, so that v2 stays a reliable bridge.
18. As the owner, I want the suite to stay green (minus removed-feature tests), so that removals don't mask regressions.
19. As the owner, I want the upstream fix PR (#53) to remain valid, so that upstream still gets the non-breaking improvement.
20. As the owner, I want defaults recorded, so that I can verify autopilot decisions when I return.

## Implementation Decisions

- **Approval posture:** `session/start` hardcodes `approvalMode: "allowAll"` for both backends. The `OPENCODE_MUSE_APPROVAL_MODE` knob, `ApprovalExchange`, `UserInputExchange`, conversational verdict/answer peek/consumption, prompt rendering, and approval/userInput stream events are removed.
- **Residual approvals:** hardcoded autoapprove — the first offered choice with `decision: "approve"` is sent via `approval/decide`; if none, the request is acked and nothing else happens. No scope preference, no ambiguity analysis, no reject/interrupt path (owner: "do not presume there are pathing vis-a-vis approval"). No persistence, no user interaction.
- **Residual userInput:** hardcoded auto-cancel via `userInput/cancel`; the turn proceeds or fails on its own.
- **Recovery:** poisoned/stale registry entries are auto-abandoned at resolve time (drop linkage, start fresh), with a one-line session notice instead of a question. Registry integrity checks (workspace mismatch, corrupt records) remain fail-closed.
- **Meters architecture:** TUI-only part; no server changes, no RPC. The TUI part spawns `muse usage` (sanitized env like other Muse children: strip `META_API_KEY`/`MUSE_CONTRIBUTOR_MODE`, set `MUSE_NO_AUTO_UPDATE=1`), parses the two lines, renders via `context.ui.slot({ append: "sidebar.content", ... })` with theme tokens. Poll interval fixed 60s; cleanup on disposal. (Source: https://opencode.ai/docs/build/plugins/cli — Slots, Theme; https://opencode.ai/docs/build/plugins — Parts/exports.)
- **Parse contract:** `Window: <n>% used, resets in <text>` and `Weekly: <n>% used, resets in <text>`; missing/malformed lines → placeholder state, never throw into the UI.
- **Toolchain:** TypeScript Go 7 (`typescript@7.0.2`, native `tsc`) builds the project; `typescript-5` (npm alias of 5.9.3) is kept solely for the AST comment-stripper tooling API, which TS7's JS wrapper does not expose. All code comments are stripped (owner mandate) via parser-aware comment ranges with parse verification.
- **Packaging:** package.json gains `"./tui"` export; peer deps `@opentui/core`, `@opentui/solid`, `solid-js` (optional, per docs); TUI JSX compiles with tsc via `"jsx": "react-jsx"`, `"jsxImportSource": "@opentui/solid"` (build-probe result: the `@opentui/solid/jsx-runtime` emits real OpenTUI renderables; `solid-js/h` would emit hyperscript vnodes).
- **Identity:** plugin id stays `opencode-muse` (OpenCode dedupes by id); package name stays `opencode-muse`; repo/README brand is opencode-muse-v2; version 2.0.0.
- **Config swap:** OpenCode plugin entry points at the GitHub fork. Docs list npm/local/file specifiers; `github:` support is probed empirically. Fallback (recorded default): `file:` entry to a local clone of the fork, refreshed by git pull.
- **Removal discipline (deprecation-and-migration):** replacement behavior lands first (allowAll + auto-decide + auto-recover), then the old machinery is deleted in one contract pass: code, tests, docs, README sections; grep verifies zero references to removed symbols; suite ratchet accounts for removed tests in the commit message.

## Testing Decisions

- Good tests here assert external behavior at the highest existing seam: the fake-MSP-host session-manager harness (what `session/start` carries, what happens on `approval/request`, what a stale registry entry does at resolve) and pure-function tests for the usage parser/render model. No implementation-detail tests.
- Prior art: `test/unit/session-manager.test.ts` (fake host, captured commands), `test/unit/msp-host.test.ts` (server-request handling), `test/unit/conversational-approval.test.ts` (deleted with the feature), `test/unit/tool-backend.test.ts` (knob tests, deleted with the knob).
- New: `test/unit/usage.test.ts` (parser: valid, partial, malformed, empty; render model: percentages, reset text, placeholder) and TUI wiring smoke via the built entry import.
- Live evidence (external constraint): real `muse serve` turn under the DEFAULT Muse profile completes with zero approval/recovery prompts; `muse usage` parse matches the real CLI output; OpenCode loads the fork entry and lists Muse models.

## Commands

- Build: `bun run build`
- Focused tests: `bun test ./test/unit/<file>.test.ts`
- Full suite: `bun test ./test/run.ts`
- Live turn: `opencode run --standalone --model muse/muse-profile-tbh-model-muse-spark-1.3 "<fixed-token prompt>"`

## Project Structure

Unchanged from upstream except: `src/usage.ts` (parser + render model, new), `src/tui.tsx` or `src/tui.ts` (TUI part, new), removed approval/recovery UX modules, `SPEC-v2.md`, `CONSTRAINTS.md`, `tasks/` (plan + ticket index).

## Code Style

Strict TypeScript ESM, repo idioms: typeof-guarded wire parsing, fail-closed on ambiguity, env-knob pattern only where a knob survives (none for meters). Example (existing idiom): `...(typeof params.toolName === "string" ? { toolName: params.toolName } : {})`.

## Boundaries

- Always: run build + focused tests before commit; full suite at task end; cite official docs for OpenCode API usage; sanitize Muse child env.
- Ask first (owner verification pending — autopilot defaults recorded): changing plugin id, publishing anywhere.
- Never: read/log Muse credentials or config; create persistent approval policy plugin-side; invent choice ids; weaken CONSTRAINTS.md to pass; push to upstream.

## Success Criteria

1. `session/start` carries hardcoded `approvalMode: "allowAll"` for every session, both backends (test).
2. A wire `approval/request` is auto-approved with the first offered approve choice, no user-visible output; with no approve choice it is acked without further action (test).
3. A wire `userInput/request` is auto-cancelled, no user-visible output (test).
4. A stale registry entry auto-recovers with a notice, no question (test).
5. Zero references to removed approval/userInput/recovery UX symbols remain (grep evidence in PR).
6. Two meters render from real `muse usage` output; parser handles malformed input quietly (tests + live parse).
7. Full suite: no new failures vs baseline; removed tests accounted (suite output in PR).
8. Live: fixed-token turn under default profile completes, zero prompts (verbatim output in PR).
9. OpenCode loads the fork entry; Muse models listed; version 2.0.0 (command output in PR).

## Out of Scope (Deferred)

- Meter customization (themes, intervals, extra providers, status line, toasts) — explicitly rejected by owner.
- Desktop GUI part — TUI only.
- Upstream contribution of v2 posture — upstream keeps its safety default; only PR #53 goes upstream.
- npm publication — fork installs via GitHub/local entry.

## Further Notes

- Autopilot defaults D1–D8 recorded in tasks/plan.md for owner verification.
- Cross-model doubt review skipped: non-interactive context (doubt-driven-development rule); single-model oracle review runs instead.
- Sources: https://opencode.ai/docs/build/plugins ; https://opencode.ai/docs/build/plugins/cli ; `muse usage` CLI output observed 2026-11-15.
