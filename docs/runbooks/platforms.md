# Desktop platforms

macOS, Linux and Windows x64 have desktop builds. Windows CI executes native checks and generates MSI/NSIS installers on main; manual installation and desktop onboarding verification remain pending.

| Platform | Runtime implementation | Evidence and remaining verification |
| --- | --- | --- |
| macOS / Apple Silicon | Existing Keychain, host computer use and Apple container provider | Existing macOS CI/release commands retained; no macOS execution on the Linux host |
| Linux / x86_64 | Secret Service, local bots/browser, Podman or Docker OCI bots | Native checks and compiled bot/API smoke; earlier port sessions built AppImage/.deb packages. The current integration still needs packaged GUI revalidation and the release dependency audit in [#154](https://github.com/touri-ai/touri/issues/154); live OCI was blocked by host user-namespace policy |
| Linux / arm64 | Same Linux runtime; native GTK/WebKit packaging required | Sidecar cross-build only; native packages/runtime still need ARM64 hardware |
| Windows / x86_64 | Credential Manager, ConPTY, authenticated loopback RPC/MCP, private file/lock/job helpers, Docker Desktop WSL2 provider | Native Rust, portable and compiled smoke checks pass in [main CI](https://github.com/touri-ai/touri/actions/runs/39135288527); `touri-windows-x64` contains MSI/NSIS installers. Manual installation/onboarding verification remains pending |

## Linux

Linux builds are phase-one candidates. The shipping dependency gate retains main's macOS scope. A diagnostic Linux audit is blocked by the GTK 3 dependency graph: glib's [string-variant iteration advisory](https://rustsec.org/advisories/RUSTSEC-2024-0429.html), an [unmaintained build macro](https://rustsec.org/advisories/RUSTSEC-2024-0370.html), and the policy's missing acceptance of target-lexicon's LLVM license exception. [Issue #154](https://github.com/touri-ai/touri/issues/154) tracks remediation before a Linux release. Compilation and API smoke results do not establish a clean dependency audit or application-level reachability of the affected iterator.

Use Bun 1.4.3+, Rust 1.90+, GTK 3, WebKitGTK 4.1, Ayatana AppIndicator, librsvg, D-Bus development headers, patchelf and xdg-utils. Debian packages include `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev patchelf xdg-utils`. AppImage bundling requires network access to Tauri's packaging tools. `APPIMAGE_EXTRACT_AND_RUN=1` supports build hosts without FUSE.

```sh
bun install --frozen-lockfile
bun run build:sidecar:linux
bunx tauri build --bundles appimage,deb
```

Artifacts are under `src-tauri/target/release/bundle/{appimage,deb}`. For ARM64, run `bun run build:sidecar:linux:arm64` and build the shell on an ARM64 Linux host with its native development libraries. Generating the ARM64 sidecar alone does not cross-compile GTK/WebKit.

Desktop data uses `$XDG_DATA_HOME/touri`, defaulting to `~/.local/share/touri`. The existing headless server keeps its historical `~/.touri` default. `TOURI_APP_DATA` isolates a development/test instance. Host and MCP bridges use Unix sockets in the private run directory. Linux single-instance handoff uses a private XDG runtime directory, with a private cache directory fallback.

Secrets require a session D-Bus and an unlocked Secret Service, such as GNOME Keyring or a configured KeePassXC. A missing/locked service is an error with a doctor explanation; the desktop never falls back to plaintext storage. The separate server CLI retains its own existing secret-store policy.

Local bots are the default. For isolated bot containers, configure rootless Podman (preferred) or Docker, and check `podman info` / `docker info` in your terminal. Podman needs subordinate user IDs, unprivileged user namespaces, slirp4netns and the kernel support needed by nftables. Merely installing a container binary is insufficient. If the engine is unusable, `/machines` reports it unavailable and doctor explains that local bots remain available.

OCI bots use the existing `touri-bot:8` image, persistent workspace/browser mounts, a guest network namespace, and the same root-owned nftables policy and DNS controls. Guest control/browser/display ports are reached through private exec relays, never published ports. Podman disables slirp host loopback. Startup/network policy failures stop the bot. These Linux containers share the host kernel; they do not provide the separate guest kernel of Apple's VM backend. Docker access inherits the privileges of the configured daemon.

The current login UI imports an existing host login file or stores pasted credentials in the native vault. The PTY command adapter uses util-linux `script` for future interactive helpers; this change does not add a terminal/login UI. No provider login is required for build or fake-provider tests.

Host computer control is currently macOS-only and is hidden on Linux/Windows. Linux notifications and login startup use the Tauri platform plugins. Links/folder reveal use xdg-open. Local browser automation uses distribution Chromium/Chrome or `TOURI_CHROME_BIN`; no macOS browser download is attempted.

On hosts with limited disk space, disable incremental/debug artifacts while compiling. Remove disposable `src-tauri/target` intermediates after preserving bundles. A first guest image build may need substantially more space than the desktop build.

## Windows runtime and builds

Use Bun 1.4.3+, Rust 1.90+ with the native MSVC toolchain, Windows x64 and WebView2. VM bots additionally require a Windows release supported by Docker Desktop, its WSL2 backend and Linux containers. No container engine is required for local bots.

```powershell
bun install --frozen-lockfile
bun run build:sidecar:windows
cargo test --manifest-path src-tauri/Cargo.toml
bun run test:sidecar:portable
bun --cwd ui test --maxWorkers=2 --minWorkers=1 --testTimeout=30000
bun run test:sidecar:smoke
bun run tauri build --bundles "msi,nsis"
```

The sidecar is `src-tauri/binaries/touri-sidecar-x86_64-pc-windows-msvc.exe`. MSI/NSIS output is under `src-tauri/target/release/bundle/{msi,nsis}`. For v0.3.0, the installers are `touri_0.3.0_x64_en-US.msi` and `touri_0.3.0_x64-setup.exe`. CI runs `bun run tauri build --bundles "msi,nsis"` on pushes to main and uploads both installers and the sidecar as `touri-windows-x64`. Installers are unsigned; SmartScreen may show **More info → Run anyway** (**Mais informações → Executar assim mesmo**).

`build:sidecar:windows:gnu` creates the equivalent GNU-named sidecar; `cargo check --target x86_64-pc-windows-gnu --tests` checks Windows Rust code from Linux with MinGW installed. These cross-builds do not execute Windows code or create a validated installer.

Desktop data uses `%APPDATA%\touri`, with `TOURI_APP_DATA` as an override. The shell passes its own executable as `TOURI_DESKTOP_HELPER`. When running sidecar source independently on Windows, set that variable to a built `touri.exe`. The portable test/smoke scripts locate `src-tauri/target/debug/touri.exe`, built by `cargo test`.

Single-instance handoff uses a named pipe whose name carries the user's SID (and, with `TOURI_APP_DATA`, a hash of that path). Its DACL admits only SYSTEM and that user, and it refuses remote clients. A second launch exits after checking that the pipe's server process runs as the same user; it lets that process take the foreground, and the running instance shows its window. A pipe held by another account never makes a launch exit: touri starts without the handoff.

The helper runs before GUI initialization. Private file operations use current-user/SYSTEM DACLs and hold directory handles against ancestor replacement. Reparse points and device/alternate-stream names are rejected; private file reads and replacements also reject hard links. Database preparation, atomic writes and bot-home removal use this boundary. Runtime ownership uses a native byte-range lock, released when the sidecar's helper input closes. Parent monitoring uses a process handle; ordinary child protocols use Windows jobs so cancellation cleans their process trees. POSIX libraries are loaded only by operations that use them.

The provider-login PTY interface selects ConPTY and streams browser-code input through stdin, flushes terminal prompts and preserves the child exit status. It accepts native provider executables; an npm batch wrapper may need its underlying `node.exe` entrypoint instead. The current settings UI still imports host login files or pasted credentials; no terminal/login UI was added. Host credential-file reads use the native bounded-file interface on Windows. No real provider login was used in development or tests.

Host RPC binds an ephemeral IPv4 loopback listener and authenticates with the shell token before privileged requests. MCP independently binds loopback and publishes `run/mcp-endpoint.json` inside the private data directory. Clients validate that endpoint and retain per-thread/run tokens, typed request IDs, token revalidation and revocation. The VM bridge uses the same endpoint parser. Unix sockets remain the transport on macOS/Linux.

Docker Desktop reuses the OCI image, lifecycle, named volumes, nft/DNS policy and private exec forwarding. Health checks require a local Docker Desktop named-pipe context, Linux containers and WSL2 kernel metadata; remote contexts and incompatible engines report an actionable local-bot fallback. Private control/display relays use random Windows pipe names; guest ports are not published. The containers share the WSL2 Linux kernel, and Docker access inherits the daemon's privileges. Doctor does not start Docker Desktop or change its settings.

### Windows gaps and native validation

These features still need implementation:

- Native identity for drag-and-drop attachment grants. Grants explicitly fail closed on Windows.
- Local workspace directory-descriptor browsing and streamed local evidence-image reads. These paths fail closed rather than emulate POSIX descriptors.
- Local Chromium's extra pipe descriptors. Use the container browser; host computer control is hidden.
- Remote snapshot download publication and the legacy SQLite snapshot importer, which retain POSIX-specific operations. Local OCI export uses the engine CLI and still needs native validation.

Native Rust fixtures, portable transport/provider checks and the compiled sidecar smoke pass in
[main CI](https://github.com/touri-ai/touri/actions/runs/39135288527). This establishes automated
runtime coverage and installer generation, with the following manual validation still pending:

- MSI and NSIS installation, WebView2 cold launch, tray, notifications, startup registration and uninstall under a standard user.
- Docker Desktop WSL2 image boot, persistent volumes, guest browser/display, cancellation and fail-closed network/DNS isolation, including access from a second Windows user.
- Provider executable discovery, browser/device-code authentication and credential persistence across app restarts. Only inert provider/console fixtures were run here; native accountful onboarding remains untested.

## Platform CI

### Local provider folder security

On macOS, local Claude, Codex and OpenCode processes inherit a Seatbelt profile, including their shell commands and descendants. Explicit read-only folder grants remain read-only even with full provider access; sensitive host trees and touri's API credentials are excluded except for explicit grants and the bot's own runtime files.

Linux and Windows do not currently have an equivalent outer sandbox for local provider processes. Local bots without folder grants still use the provider's access and approval policies: Claude's tool allow/deny rules, Codex's sandbox configuration and OpenCode's permissions. Those provider policies do not establish the inherited host boundary that Seatbelt provides, especially for shell commands and provider approval bypasses. Local launches with explicit folders or `anyFolderAccess` fail closed before spawning: the spawn boundary returns `SPAWN_FAILED`, which the provider adapters report as `cli_crash`, with an explanation that folder access requires the macOS sandbox. Removing those grants permits the ordinary local mode with provider-enforced restrictions; it does not add host isolation.

Guest executions retain provider CLI folder rules and the guest's outer isolation, with read-only bind mounts and sensitive-path masking. Folder policy tests use inert provider fixtures for both local and guest execution; no real provider CLI or VM is needed.

`.github/workflows/ci.yml` pins Bun 1.4.3 in every Bun job, as does the release workflow. All pull requests run the three macOS sidecar shards, the Linux platform/confinement selection, UI tests with Vitest and the UI build. Native, policy and workflow changes also run the native Rust checks, the Windows portable sidecar suite and compiled smoke, and the Linux native integration checks. Main and manual runs keep the full Linux sidecar suite and Linux/Windows installer uploads. Rust builds on `macos-26` for the Apple Metal SDK.

The portable sidecar selection is explicit in `scripts/test-sidecar-portable.ts`; Unix permission/signal/FFI fixtures and opt-in integration suites remain in the full Linux/macOS runs. `scripts/smoke-sidecar.ts` compiles an inert Codex-protocol fixture, creates a local bot and checks its persisted first reply without a provider account. CI does not perform real provider logins or live VM onboarding.

## Publish a release

Merge the version bump and its `## X.Y.Z` section in `CHANGELOG.md` to main after CI and the
platform review pass. Keep the package, Cargo and Tauri versions aligned. The Linux dependency
audit tracked in [#154](https://github.com/touri-ai/touri/issues/154) and the manual platform checks
above remain release review items; packaging does not establish that those checks passed.
Create and push the matching tag from that commit (replace `X.Y.Z` with the version):

```sh
git switch main
git pull --ff-only origin main
git tag vX.Y.Z
git push origin vX.Y.Z
```

Only numeric `vX.Y.Z` tag pushes (filter `v[0-9]+.[0-9]+.[0-9]+`) start
`.github/workflows/release.yml`, for example `v0.3.0` or `v12.34.567`. Suffixes such as `-rc.1`
and build metadata such as `+build.1` are excluded because the Windows MSI version must be numeric.
The `validate` job enforces the same contract before any platform build; publication also requires
a nonempty changelog section matching the version without `v`.

| Job | Runner | Build and uploaded artifact |
| --- | --- | --- |
| `validate` | `ubuntu-latest` | Rejects nonnumeric version tags before the three builds |
| `macos` | `macos-26` | Apple Silicon sidecar, `.app` and `.dmg`; uploads the DMG as `touri-<tag>-macos-arm64` (the app is inside the DMG) |
| `linux` | `ubuntu-latest` | x64 sidecar, AppImage and `.deb`, with CI's native Linux dependencies; uploads installers as `touri-<tag>-linux-x64` |
| `windows` | `windows-latest` | MSVC x64 sidecar, MSI and NSIS `.exe`; uploads installers as `touri-<tag>-windows-x64` |
| `publish` | `ubuntu-latest` | Waits for all three builds, downloads their artifact IDs from this run, requires all five versioned installers and flattens filenames; creates a pre-release only if absent, uploads missing assets and publishes `SHA256SUMS` last |

The builds have `contents: read`; only `publish` has `contents: write`, with `GH_TOKEN` explicitly
passed only to the GitHub CLI publication step. All external actions are pinned to full commit SHAs.
Each platform explicitly installs stable Rust with the SHA-pinned `dtolnay/rust-toolchain` action
(including the Apple Silicon target on macOS), rather than relying on the runner's preinstalled Rust.
The action revision is fixed; the stable compiler channel can advance between runs.
The publish job installs no dependencies and never executes downloaded artifacts. Notes contain
only the matching changelog section, ending before the next version heading. Missing or duplicate
installers, unexpected assets and missing/empty notes fail before any release write.

Release Rust builds remap runner home and workspace prefixes through `RUSTFLAGS` and
`CARGO_ENCODED_RUSTFLAGS` (preserving Windows paths with spaces). Each build checks the shell
and compiled sidecar for the runner home in UTF-8 and UTF-16LE, including Windows slash variants,
and fails before uploading if a home path remains. SHA256SUMS hashes the final downloadable files;
verify locally with `sha256sum --check SHA256SUMS` after downloading all assets.

Signing, notarization and updater switches remain `false`; these installers are unsigned.
After a failure, rerun the failed jobs in the tag's Actions run. Existing asset names, including
`SHA256SUMS`, are skipped and logged; uploads never replace or delete published bytes. An existing
release's title, notes, draft/pre-release status and latest designation remain unchanged, including
after promotion. Only a new release gets the tag title, changelog notes, pre-release status and
`latest=false`. Lookup errors other than HTTP 404 stop publication without attempting creation.

Installers are not reproducible across builds. If `SHA256SUMS` is absent, publication downloads
and hashes preserved assets, combines those hashes with the missing local installers, then uploads
the manifest only after all installer uploads succeed. A failed upload leaves existing assets intact
and no premature manifest; rerunning completes the missing uploads. If a manifest already exists,
each missing local asset must match its published checksum before any upload is attempted. A
mismatch stops publication: rerun using the original successful build artifacts (rerun only the
publish job), or ship a new version/tag; never overwrite an installer or checksum to repair it.
Runs for the same tag are serialized. A concurrent external upload fails on duplicate names without
overwriting them; retry to refresh the asset list. Reruns never move the tag.

## Validation without provider accounts

The report ZIP tests additionally need `unzip`.

```sh
TOURI_VM_INTEGRATION=0 TOURI_E2E_REAL_CLI=0 TOURI_OPENCODE_REAL=0 \
  TOURI_DOCTOR_SKIP_PROVIDER_PROBES=1 bun test --timeout 30000 sidecar/test
bun --cwd ui test --maxWorkers=1 --minWorkers=1 --testTimeout=30000
bun run typecheck
bun run lint
dbus-run-session -- bash scripts/test-native-linux.sh
```

Linux native integration tests require an unlocked Secret Service; `scripts/test-native-linux.sh` creates an isolated test keyring/session for them and also runs the dedicated round trip. The dedicated native secret round-trip test is ignored by default because it requires an unlocked desktop service. In an isolated session with such a service, run `cargo test --manifest-path src-tauri/Cargo.toml native_secret_round_trip -- --ignored`. It uses a dedicated test service/account and deletes its fixture. Fake provider fixtures can exercise the first-message protocol without launching any real provider CLI.

Bun 1.2.21 aborted in native/JSC code during the full Linux suite on the port host, including in a JIT-disabled retry, and intermittently crashes in the macOS suite. All CI and release jobs that use Bun pin [Bun 1.4.3](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.3). Use the baseline Linux x64 Bun distribution on hosts without AVX.
