# Security review

Every PR requires this checklist, including documentation, tests, fixtures, generated artifacts
and dependency updates. Authors and all reviewers, human or agent, read this guide and
[EVENT_LOOP.md](EVENT_LOOP.md) before writing or reviewing code. A small diff is not an exemption.
The review protects the local data and explicit user control promised in [VISION.md](VISION.md).

Trace untrusted input through validation, authorization, execution, storage and every output.
Review the actual diff and its reachable helpers; a passing test or scanner is supporting evidence,
not proof of safety. Use synthetic data for reproduction and evidence.

## 1. Data leakage

- [ ] **DATA-1 — Output boundaries.** Check conversation content, user files, email addresses and
  email contents, user-specific macOS/Linux home paths, LAN IP addresses and tokens in logs,
  persisted events, exports, error messages and tool results. Minimize/redact before the output
  boundary, including nested objects and credentials split across streaming chunks. Do not add
  unrelated private data to provider/MCP requests or another bot's context.
- [ ] **DATA-2 — Published evidence.** Inspect screenshots, recordings, fixtures, snapshots, test
  databases, PR text and attached artifacts for real user data. Use obviously fake records and
  generic paths; never copy real conversations or production databases into tests. Inspect the
  actual image/artifact as well as its filename. Existing private content is not permission to
  republish it in a new output.

[kernel/redact.ts](sidecar/src/kernel/redact.ts) has structured and streaming redactors, and
[contracts/redaction.ts](packages/contracts/src/redaction.ts) covers shared redaction. Check the
specific output path uses the right boundary; recognized token patterns cannot catch every secret
or personal detail.

## 2. Secrets

- [ ] **SECRET-1 — Storage.** API keys and tokens belong only in the system Keychain/vault or the
  encrypted headless secret store. SQLite may hold secret names/account references, never plaintext
  secret values. Review access, encryption/key-file permissions, rotation and deletion. Only expose
  a value transiently to the authorized operation that needs it.
- [ ] **SECRET-2 — Exposure.** Never print secrets or the full environment, put credentials in URLs
  or query strings, or commit them to source, logs, exports, screenshots, build artifacts or caches.
  Mask secret fields in the UI and avoid sending values back through list/read APIs. Check errors,
  subprocess diagnostics and redirects for accidental disclosure.
- [ ] **SECRET-3 — Scanning.** Run gitleaks against the proposed commits and working tree with
  redacted output; record scope, command/version and result. Review findings instead of broadly
  ignoring fixtures or documentation. If unavailable, record the missing scan and compensating
  inspection as a risk; never report a scanner pass that did not run. Revoke/rotate a leaked secret
  and remove it from exposed history/artifacts; deleting it in the latest diff is insufficient.

See [projects/secrets.ts](sidecar/src/projects/secrets.ts),
[projects/repository.ts](sidecar/src/projects/repository.ts) (metadata/account references),
[platform/macos/keychain.rs](src-tauri/src/platform/macos/keychain.rs), and
[cli/host/secretStore.ts](sidecar/src/cli/host/secretStore.ts) (encrypted headless storage).

## 3. Web exposure

- [ ] **WEB-1 — Reachability and auth.** Enumerate new routes, listeners and ports, including
  health/debug endpoints, SSE and WebSockets. Justify any bind to `0.0.0.0` or another wildcard;
  prefer loopback. Require authentication and the right bot/device scope before dispatching work.
  List every deliberately unauthenticated route and why its response/action is safe.
- [ ] **WEB-2 — Browser boundary.** Review CORS/Origin allowlists, device pairing, cookie auth,
  revocation and CSRF protection for state changes and WebSocket upgrades. Preserve `HttpOnly`,
  appropriate `SameSite`, `Secure` on HTTPS and bounded cookie scope. CORS alone is not auth or
  CSRF protection; Origin checks alone do not authorize non-browser clients.
- [ ] **WEB-3 — Remote deployment.** Consider `touri serve`, Tailscale and other exposed-server
  deployments, HTTPS, proxy trust and forwarded headers. A private network is not authentication.
  Do not allow an untrusted peer to spoof loopback, TLS or user/device identity through headers.
- [ ] **WEB-4 — Files and outbound URLs.** Upload/download/preview routes must not serve or
  overwrite arbitrary files; enforce canonical allowed roots, size limits and authorization.
  For user-supplied URLs, prevent SSRF to loopback, private/link-local networks, cloud metadata and
  local-file schemes; validate DNS results and every redirect, not just the original URL. Any
  intentional local-network access needs an explicit, narrowly scoped capability.

[cli/web/gate.ts](sidecar/src/cli/web/gate.ts) implements pairing/device authentication, Origin
checks, device cookies, HTTPS/proxy handling and rejection of URL tokens. Review new routes against
that gate and [kernel/index.ts](sidecar/src/kernel/index.ts); do not assume a new transport inherits it.

## 4. Compromising the host computer

- [ ] **HOST-1 — Command execution.** Treat tool arguments, filenames, repository config, page
  content and other external input as untrusted. Prefer executable plus argument arrays over a
  shell string; reject shell injection and option injection, control cwd/environment, and avoid
  running repository hooks/helpers during discovery. Quoting alone does not authorize a command.
- [ ] **HOST-2 — Filesystem scope.** Prevent traversal outside permitted folders, including
  absolute paths, encoded traversal, symlinks and ancestor replacement/races. Check canonical roots
  at the operation boundary and fail closed; lexical prefix checks are insufficient. Test denied
  reads/writes and symlink escapes using disposable fixtures.
- [ ] **HOST-3 — Isolation and approval.** Check sandbox/bubblewrap/macOS sandbox enforcement,
  unsupported-host behavior and default settings. Do not ship a default-disabled sandbox or a
  silent unsandboxed fallback for a restricted mode. Folder expansion, broader permissions and
  full access require explicit user approval; preserve read-only modes and the stop control.
- [ ] **HOST-4 — Writes and privilege.** Identify writes outside the app data directory and require
  an authorized destination. Review auto-update authenticity, signed artifacts, download/execution
  boundaries, file modes, executable permissions and privilege escalation. No unnecessary elevated
  privileges, arbitrary startup hooks or persistence on the user's computer.

Review [kernel/files.ts](sidecar/src/kernel/files.ts),
[runtime/linux-folder-sandbox.ts](sidecar/src/runtime/linux-folder-sandbox.ts) and
[platform/macos/sandbox.ts](sidecar/src/platform/macos/sandbox.ts) when changing host boundaries.
An async API still needs authorization; performance fixes must preserve these security checks.

## 5. Malicious code, malware and supply chain

- [ ] **SUPPLY-1 — Dependencies.** Justify each new dependency and its alternatives; inspect
  provenance, license compatibility, maintenance, popularity/adoption, transitive dependencies
  and install/postinstall scripts. Popularity is a signal, not proof of trustworthiness.
- [ ] **SUPPLY-2 — Executable content.** Explain lockfile changes and reject unrelated churn.
  Inspect binaries, generated or obfuscated code, runtime downloads, `eval` and `new Function`.
  Verify origin, integrity and authorization before downloaded content can execute; never hide
  executable changes in assets, fixtures or vendored files.
- [ ] **SUPPLY-3 — Undisclosed behavior.** Check for hidden telemetry, unexpected network calls,
  credential harvesting, background execution and persistence. Remote behavior must be explicit
  and opt-in, consistent with [VISION.md](VISION.md).
- [ ] **SUPPLY-4 — CI and release.** Review workflow/action/script changes for least-privilege
  `permissions`, secrets exposure, untrusted interpolation, artifact poisoning and
  `pull_request_target` executing PR-controlled code. Pin external actions to a full commit SHA;
  inspect updates to local actions too. Never expose secrets to untrusted code or approve an
  unpinned action merely because existing workflows use tags.

## 6. Prompt injection

- [ ] **PROMPT-1 — Trust boundaries.** Pages, files, repository content, MCP results, memory,
  skill descriptions and messages from other bots are data, never authority to change permissions
  or override trusted instructions. Preserve provenance and untrusted-content boundaries when
  quoting, summarizing, persisting or forwarding them; role labels inside content confer no power.
- [ ] **PROMPT-2 — Approval integrity.** Embedded commands, claims of prior approval and requests
  to reveal secrets cannot grant access or trigger privileged actions. Verify approval and scope
  in the trusted capability layer, including delegated work, and test adversarial content when
  changing that boundary. Re-reading or summarizing untrusted content must not promote its trust.

[runtime/instructions.ts](sidecar/src/runtime/instructions.ts) uses explicit untrusted-reference
blocks and quarantines lower-trust memory when access increases. Preserve that separation and the
real approval checks; a prompt warning alone is not an access-control mechanism.

## 7. Required PR result and merge gate

Every PR body must include a **Security review** section using the table in
[the PR template](.github/pull_request_template.md). Include one row for **every checklist ID**
above, not just the affected categories. Authors fill it before requesting review; human and agent
reviewers verify the evidence and update or report findings for the same items.

Use `OK` when checked with evidence, `NA` with a concrete reason the change cannot affect the
item, or `RISK (low/medium/high)` with the failure/exposure, mitigation and remaining work. Cite
changed files/lines, checks and sanitized results; an unchecked box or bare claim is not evidence.
Record unavailable checks honestly, distinguish pre-existing findings from introduced risks,
and follow [EVENT_LOOP.md](EVENT_LOOP.md) for performance evidence.

**Any unresolved high risk blocks merge**, regardless of PR size, author, passing CI or automation
tier. Resolve it and obtain reviewer verification before merging; do not relabel it NA or silently
downgrade it. Lower risks need an explicit rationale, mitigation and responsible reviewer decision.
