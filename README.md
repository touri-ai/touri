<p align="center">
  <img src="docs/assets/touri-logo.png" alt="touri" width="160">
</p>

# touri desktop

touri is a local-first macOS app for running persistent AI teammates ("bots") on your own
Codex, Claude Code or OpenCode CLI. Everything runs on your Mac: your conversations, memory, routines
and secrets never leave the machine unless you explicitly configure a remote.

Built with Tauri v2 (Rust shell), a Bun sidecar and a React UI.

## Features

- Persistent bots with their own instructions, memory, skills and full branching chat history.
- Codex and Claude Code runtimes, with approval modes (`on-request`, `workspace-write`, `full`).
- Routines: cron-scheduled bot runs with overlap and catch-up control.
- Projects: connect a local repo, run supervised processes (databases, servers) and preview them in-app.
- Agent browser with human take-over, and opt-in computer use with a visible indicator and kill switch.
- MCP gateway with per-thread tokens and approval prompts.
- Bot machines: optional isolated Linux VMs through Apple `container`.
- Importer for data exported by an earlier setup (see below).

## Privacy

- Local-first: data lives in SQLite under `~/Library/Application Support/touri`.
- No telemetry and no account required.
- Credentials are kept in the macOS Keychain, never in the database, logs or exports.
- Optional cloud hosting is a separate, opt-in protocol (`docs/protocol/cloud-v1.md`).

## Install (GitHub Releases)

Download the latest `.dmg` from the Releases page and drag `touri.app` to `/Applications`.
Release builds are currently unsigned and not notarized, so macOS Gatekeeper blocks the first launch:

1. Open `touri.app`. macOS shows a warning and refuses to open it.
2. Open System Settings > Privacy & Security, scroll to the message about touri and click "Open Anyway".
3. Confirm with your password. Later launches open normally.

On macOS 15 and later, Control-click > Open no longer bypasses Gatekeeper, so use the steps above.

Or remove the quarantine flag from a terminal:

```sh
xattr -dr com.apple.quarantine /Applications/touri.app
```

## Requirements

- macOS 14 or newer on Apple Silicon. The optional bot-machine feature needs macOS 26 and Apple `container` >= 1.5.0;
  on older systems local bots keep working and the machine feature reports itself as unavailable.
- Bun 1.2.21 or newer
- Rust 1.90 or newer with the `aarch64-apple-darwin` target
- A Codex or Claude Code CLI signed in on your Mac

## Build from source

```sh
bun install
bun run build:sidecar
bun run tauri build --bundles app
open src-tauri/target/release/bundle/macos/touri.app
```

For local rebuilds that retain saved logins, use [stable macOS signing](docs/runbooks/macos-vault.md) and `scripts/build-macos-signed.sh`.
Signing, notarization and the updater are wired but disabled (`docs/DECISIONS.md`).
For development: `bun run build:sidecar && TOURI_SIDECAR_BIN="$PWD/src-tauri/binaries/touri-sidecar-aarch64-apple-darwin" bun run tauri dev`.

## Verify

```sh
bun run typecheck
bun run lint
TOURI_BROWSER_HEADLESS=1 bun test sidecar/test
(cd ui && bunx vitest run && bunx vite build && bunx playwright test)
(cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings)
```

Opt-in real CLI smoke: `TOURI_E2E_REAL_CLI=1 bun test sidecar/test/runtime/real-cli.test.ts`.

## Import from a previous setup (dry run)

The importer reads the data directory of an earlier bot setup, from a local path or over SSH,
and maps bots, chats, memory, skills and routines into touri. It is idempotent, imports routines
disabled, and never reads credential files.

```sh
TOURI_APP_DATA="$HOME/Library/Application Support/touri-dev" \
  bun sidecar/src/importer/legacy/cli.ts --source ssh --host user@host.example \
  --root '~/.legacy-app' --dry-run --all
```

The SSH source is read-only on the remote (allowlisted files only, no remote writes).
Drop `--dry-run` to import, `--bot <name>` selects bots, `--cwd-map <from>=<to>` maps paths.

## Run the sidecar directly

```sh
TOURI_UI_TOKEN=dev-ui-token bun run sidecar/src/main.ts serve
```

It prints one `SidecarHandshake` JSON line to stdout. The MCP stdio mode is a byte
pipe for a running sidecar and reads only the per-thread token file; it does not open
SQLite:

```sh
bun run sidecar/src/main.ts mcp-stdio --thread <thread-id>
```

## Repository rules

`packages/contracts/` holds the shared types, SQL schema and MCP tool schema; changes
there require a contract change before dependent work merges. Credentials are never
imported or stored in SQLite. See `CONTRIBUTING.md`, `SECURITY.md`, `NOTICE` and
`TRADEMARKS.md`.

## License

Apache-2.0, see `LICENSE`. Third-party notices: `THIRD_PARTY_NOTICES`.

