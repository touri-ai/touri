# Saved-login vault recovery

Issue: #148. Tests use only synthetic values in dedicated test services. Existing touri credentials and ACLs were not read, overwritten, or deleted.

![Chat and Doctor offer vault authorization](recovery.png)

![The preserved attempted message resumes once](resumed.png)

The screenshots use the browser acceptance harness. It verifies a single action in chat and Doctor, a collapsed terminal alternative, and exactly one send of the preserved draft after a mocked native authorization succeeds. They are UI evidence; they do not claim system-dialog approval.

## Native macOS check

The native acceptance example uses the same `KeychainStore` implementation as the app:

| Check | Result |
| --- | --- |
| Ad-hoc build A writes a disposable item and reads it | Original synthetic value matches |
| Re-sign as build B with a different designated requirement; normal read | `VAULT_ACCESS_REQUIRED`, without waiting for system UI |
| Explicit authorization from the foreground test app | Native caller returns `VAULT_TIMEOUT` after 90 seconds without approval; requires a human to verify/approve the protected system dialog |
| Stable certificate: build A writes a separate disposable item | Success |
| Re-sign as build B with the same certificate and identifier | Designated requirement unchanged; original value reads without a new prompt |

**Pending acceptance:** a human must confirm the system authorization dialog is visible and select **Permitir sempre**, then verify the ad-hoc build B's normal read returns the original value. The automation cannot access the protected macOS authorization app. Keep the PR in draft until this check is complete. No claim is made that the installed app's existing login has been repaired.

For an affected bot after installing the candidate build: attempt to send the message, click **Permitir acesso ao cofre**, and choose **Permitir sempre** in the macOS dialog (enter the login keychain password if requested). The attempted draft retries automatically. Doctor provides the same authorization action.

Native unit tests cover the deadline, bounded concurrency after timeout, typed denied/cancelled errors and a disposable item round trip. Sidecar tests cover error propagation, source preservation and Doctor/chat agreement. The new regression tests fail against the original main implementation.

## Checks

- `bun install --frozen-lockfile` completed in each worktree with its own dependencies.
- `bunx biome check .` and `bun run typecheck` pass. Biome retains one existing unused-parameter warning outside this change.
- UI: 1,197 tests pass across 104 files. The final run used two workers after concurrent native compilation caused unrelated five-second test timeouts. Browser acceptance: one test passes and captures the screenshots above.
- Sidecar, with live VM integration disabled: VM 364 pass / 18 skip; Doctor 35 pass; kernel 165 pass; projects 75 pass. Total 639 pass / 18 skip / zero failures. Matching main worktree: 631 pass / 18 skip / zero failures. The eight added tests account for the difference. The separate login/runtime regression run passes all 160 tests.
- `cargo test`: 82 tests pass (70 library, 12 integration). `cargo clippy --all-targets -- -D warnings` reports the same two existing `cloned_ref_to_slice_refs` findings in `file_grants.rs` on main and the branch.
- `bun --cwd ui build`, sidecar compilation and `bunx tauri build --bundles app` pass. The candidate app is built without replacing the installed app.
- Regression proof against main: the three new sidecar authorization checks and the UI preserved-draft authorization check fail without the implementation.
- Signing script syntax and the missing-identity failure path pass; the script stops before building when no matching identity exists.
- Both dedicated Keychain items were removed and verified absent. Disposable test apps and identified abandoned VM resources were cleaned up. No stable identity or user vault item was deleted or changed.
