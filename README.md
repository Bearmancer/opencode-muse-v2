# opencode-muse-v2

A fork of [pgquiles/opencode-muse](https://github.com/pgquiles/opencode-muse) that runs Muse Code models in OpenCode with no ceremony.

Auth and inference stay inside the official Muse Code CLI (`muse serve`, via `@muse-code/sdk`). No credential is read, cached, or injected.

## What v2 changes

- **No approvals.** Every Muse session starts with `approvalMode: "allowAll"`. A residual `approval/request` is answered at once with the first offered approve choice; a residual `userInput/request` is cancelled. Nothing is parked, nothing is shown, nothing is configurable.
- **No recovery questions.** A stuck prior turn with an unknown outcome is abandoned automatically and a fresh Muse session starts, with a one-line notice. Corrupt registry records and workspace mismatches still fail closed.
- **Two usage meters in the TUI sidebar.** `5h` window and `Week`, each with a bar, percent used and reset time, read from the official `muse usage` CLI every 60 seconds. No settings, no commands, no toasts.
- **Built with TypeScript 7** (native `tsc`).

Muse runs its own tools with no confirmation. Use it only where that is acceptable.

## Install

Clone and build:

```sh
git clone https://github.com/Bearmancer/opencode-muse-v2.git
cd opencode-muse-v2
bun install
bun run build
```

Add the clone directory to `plugin` in `opencode.jsonc`. One entry loads the model provider and the sidebar meters:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["C:\\path\\to\\opencode-muse-v2"]
}
```

Sign in with the official CLI, then pick a Muse model:

```sh
muse login
```

Requires OpenCode 2.3+, Muse CLI 1.4.12 or newer (1.4.20 verified), and Bun.

## Usage meters

The sidebar shows:

```text
Muse usage
5h   █░░░░░░░░░ 14% · 3h 57m
Week █████████░ 93% · 20h 25m
```

If `muse usage` fails or its output changes, a meter reads `unavailable` and nothing else happens.

## Configuration

Two process-wide environment variables, read once at load:

| Variable | Values | Meaning |
|---|---|---|
| `OPENCODE_MUSE_CONTRIBUTOR_MODE` | unset or `on` / `off` | Billing lane. Default requests the Contributor lane like the Muse TUI. |
| `OPENCODE_MUSE_TOOL_BACKEND` | unset or `muse` / `opencode` | `opencode` lets OpenCode execute tools through a loopback MCP bridge. |

## Compatibility

Verified Muse CLI versions and probe results are in [docs/compatibility.md](docs/compatibility.md). Newer CLIs start under a recorded fingerprint warning.

## Credits

[pgquiles/opencode-muse](https://github.com/pgquiles/opencode-muse) (MIT) is the base. Meter placement follows [opencode-quota](https://github.com/slkiser/opencode-quota).
