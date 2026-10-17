# Decisions

Answers to the open questions in `docs/SPEC.md` section 11, recorded 2026-10-12 for the v0.1 MVP.
Each answer is the default the implementation follows until changed here.

## 2026-10-17 — Per-bot browser and personal Chrome consent (#78, schema 19)

`browser: touri | local | machine` is stored per bot. The default remains the touri-owned profile;
existing Linux VM bots migrate to `machine` because that is how vm-router already routed them.
`local` is explicit opt-in and unavailable to remote bots: a VM cannot reach the host's Chrome.

Meu Chrome attaches to the running Google Chrome, using `DevToolsActivePort` in the user's Chrome
data directory (macOS: `~/Library/Application Support/Google/Chrome`; Linux: `~/.config/google-chrome`).
Only the first-line port and second-line `/devtools/browser/...` path are accepted; the WebSocket
authority is always `127.0.0.1`. There is no HTTP discovery or fallback to the touri profile. Missing,
stale, denied or refused connections return `LOCAL_BROWSER_UNAVAILABLE` / `TOURI-E4006` and tell the
user to open `chrome://inspect/#remote-debugging`, enable remote debugging, and accept Chrome's
permission prompt when the bot connects. No subprocess, relaunch, command-line flags or process
termination is part of this flow. `stop()` only disconnects CDP.

The default browser context shares existing sign-ins. `Target.createTarget` uses `newWindow:true`
so bot work appears in a separate window. Browser-level auto-attach is disabled; only targets with
recorded `owner_bot_id` ownership and popups from those targets are managed. User tabs are never
adopted by matching URL, read or closed. Cookies stay in Chrome rather than touri's session vault.
Idle unload, bot deletion, switching browsers, shutdown and app quit close owned targets only,
never `Browser.close`. The picker explains shared sessions once, keeps consent instructions
visible, and says the user can close the window or press Stop. No new native indicator is included.

[Chrome's debugging-switch change](https://developer.chrome.com/blog/remote-debugging-port) applies
from Chrome 136 to the default data directory; touri therefore never relaunches the personal profile
with `--remote-debugging-port`. The [Chrome DevTools consent-flow documentation](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md#automatically-connecting-to-a-running-chrome-instance)
describes the inspect-page flow from M144. **Minimum supported Chrome version: still to be verified
on a Mac**, including actual DevToolsActivePort creation, permission accept/refuse, a signed-in
session, a separate window and shutdown preserving personal tabs. Fake CDP tests do not establish
real Chrome compatibility. Snapshot, refs, takeover, secret entry, retries and SITE_BLOCKED remain
the existing engine rules.

| # | Question | Decision |
|---|---|---|
| 1 | License, owner, signing, touri web code | **Apache-2.0.** Plain open source under our own copyright. All code is original and nothing is copied from other projects; `NOTICE` holds only our copyright line. The importer only reads the source data format. No GitHub org/repo and no Apple Developer team yet: builds are unsigned local builds. Signing, notarization and the updater are wired in config and the release workflow but **disabled**. |
| 2 | Import native Codex sessions | **No, by default.** The importer does not copy native Codex rollout files in the MVP; imported chats continue from a history summary (handoff packet). Copying stays implemented behind the `importCodexSessions` option (off by default, with a warning in the wizard). |
| 3 | cwd mapping for remote home paths | A **user-editable path-mapping table** (remote prefix -> local path). The default for each bot is `~/touri/workspaces/<bot>`. |
| 4 | Default access mode for new bots | **`workspace-write` with approvals.** `full` requires an explicit choice with a warning. |
| 5 | Services for multi-service projects | **Homebrew `mongod` / `redis-server`**, supervised as processes. No Docker in the MVP. |
| 6 | Routines while the app is closed | Routines run **only while the app is running** (tray + launch at login). Missed slots follow the catch-up rule in SPEC 3.8. |
| 7 | Intel Macs | **Apple Silicon only** for v0.1 (`aarch64-apple-darwin`). |
- **Test and smoke windows open on the external monitor.** Headed Chrome (browser tests, smoke) and the Tauri window in
  smoke runs are placed on the external display (left of the built-in one) so they do not disturb the user. Product code
  reads `TOURI_BROWSER_WINDOW_POSITION` (`x,y`) and `TOURI_BROWSER_WINDOW_SIZE` (`w,h`) and passes them as
  `--window-position`/`--window-size`; nothing is hardcoded. Test and smoke scripts set `-1920,-251` and `1920,1080`, and
  launches avoid taking focus on the built-in display (`open -g`, no activation) where possible.

- **Groups (schema 8).** Reimplemented from the room data idea, without upstream code. Shared
  transcripts are projections of bot-owned internal conversations. This preserves per-bot provider
  sessions, machine boundaries and approval policies. Group queues span all their conversations;
  a bounded delegation slot avoids concurrency-cap deadlock. Unfinished group turns are interrupted
  on restart instead of redelivered.

## 2026-10-14 — VM connection keys remain in memory (R11 B04)

The host-to-guest sealed connection key intentionally remains in sidecar memory. It is rotated on boot and after a sidecar restart and is not a durable login credential. Moving this key to macOS Keychain caused interactive/signature-related hangs and “conexão selada não ficou pronta” timeouts. R11 does not reintroduce Keychain storage for connection keys. Provider logins still use an explicitly selected vault or host-file source; a vault failure never selects another source.

VM image 7 separates the browser uid/profile volume from the agent workspace. X11 uses a private browser-owned authority cookie and a root-owned display server; agent processes cannot connect to X11 or guest VNC directly. Computer tools and authenticated desktop paste use the trusted display identity. Root installs an nftables packet policy before readiness; agent and browser processes cannot change it. Requested and active network settings live in host SQLite settings, outside the workload. LAN access defaults off; live updates intersect active permissions, and additions require a machine restart. Host addresses, the host-facing gateway and link-local metadata remain blocked even with LAN enabled. DNS defaults remain the existing public resolvers behind a root-owned local resolver, which blocks single-label, local/private suffix and reverse-address queries; additional private suffixes and resolver IPs are configurable. Public HTTPS traffic remains permitted.

## 2026-10-15 — Guest browser start clears stale profile locks (R11 P1 regression)

Bots created before image 7 ran Chromium as uid 1000 with `--no-sandbox` and a profile under `/workspace/.home/browser`. Init migrates that profile into the isolated browser volume, including `SingletonLock`/`SingletonSocket`/`SingletonCookie` left by the old run. Chromium on the new uid sees a lock owned by another host (or a pid from another boot) and stops behind a modal "The profile appears to be in use by another Chromium process" window: the debugging port never opens, `browser_open` stalls, and the display shows only that window. A fresh bot never has the lock, which is why the existing real-VM tests passed.

`browserEndpoint` now runs a root-only guest step before launching: when no uid 1001 Chromium is running it unlinks exactly those three names through a no-follow directory descriptor of the profile. Chromium itself still starts as uid 1001 with the sandbox on, the private X authority, and the authenticated CDP transport; no flag was relaxed and the image is unchanged (still `touri-bot:8`). Start is bounded to 25 s, watches that Chromium is still alive, restarts a wedged browser, and fails with `BROWSER_START_FAILED` and a pt-BR cause (with a redacted log tail) instead of a generic unavailable error. The desktop viewer reports a handshake or "connected but no image" stall with its own message.

## 2026-10-15 — Codex does not prompt for Touri's own MCP tools (R12 browser preview)

Codex 0.162 asks the app-server client to approve every MCP tool call when `approval_policy` is `on-request` (the default for new bots, decision 4): it sends `mcpServer/elicitation/request` with `_meta.codex_approval_kind = "mcp_tool_call"` and keeps the `mcpToolCall` item in progress until it gets an answer. Touri's adapter answered only command, file-change and permission approvals, so the request was never answered. No Codex bot with `workspace-write` access had ever executed a Touri tool: `browser_open` never reached the sidecar, the card stayed "Executando" past its `timeoutMs`, and the preview and Computer viewer stayed black ("Navegador ainda não aberto"). Bots with `full`/`read-only` access (approval policy `never`) and Claude bots were unaffected.

Touri already enforces consent for its own tools in the MCP router (`requiresPolicyGate`, an approval card for host-changing tools, and the browser's own guards per `policyGate.ts`). A second Codex prompt for the same server has no UI and duplicates that gate, so the adapter configures the `touri` server with `default_tools_approval_mode = "approve"`. This applies to new and resumed threads, VM and host. Attached third-party MCP servers are still forwarded through Touri's router and its policies. Any server request Touri cannot present now gets an immediate reply instead of hanging the turn: elicitations are declined, and unknown methods get JSON-RPC `-32601`. Browser tools now also answer within their `timeoutMs` (`DEADLINE_EXCEEDED` in pt-BR). The engine gets a smaller budget, so its own cause usually arrives first. The empty Computer viewer shows the latest failed browser tool's cause.
