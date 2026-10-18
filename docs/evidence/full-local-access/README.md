# Full local access

Synthetic local bot with full access, provider approvals disabled, and a saved read-only folder. The same browser regressions run against main (`1d026e1`) fail at both widths because its warning claims that saved folder restrictions still limit full access. With this change, both pass. Switching to restricted access restores the folder explanation without saving settings automatically.

Captures show only the access warning from the running UI. They contain no production data.

| Width | Before | After |
| --- | --- | --- |
| 390 px | ![Previous full-access warning](before-390.png) | ![Full local access follows the system account's permissions](after-390.png) |
| 1440 px | ![Previous full-access warning](before-1440.png) | ![Full local access follows the system account's permissions](after-1440.png) |

Browser evidence: `ui/test/e2e/full-local-access.spec.ts`, executed through the queued test gate with one worker: main **2 failed**, changed UI **2 passed**. Both runs use the same synthetic fixture and assertions.

Related regressions cover existing write access to the working directory, bot home and project, missing output directories, stale grants, unchanged configuration and continuation counts, approval policy, and isolated execution. See `sidecar/test/projects/setup-tools.test.ts`, `sidecar/test/runtime/folder-access.test.ts`, `sidecar/test/runtime/instructions.test.ts`, `ui/test/bot-folders.test.tsx`, and `ui/test/data-access-copy.test.ts`.

VISION promises 4 and 7: the person can understand the access they selected, in Portuguese and English, without a redundant permission loop.

The disposable server smoke used a real local provider and completed four messages: a direct write, both redundant setup tools plus another write, a write after inserting a legacy read-only grant, and a later greeting. Both setup tools returned `alreadyAccessible`; no folder or project was added. The legacy grant stayed saved while writing and conversation still succeeded. Three files contained their exact synthetic values. The server and its temporary data were then removed.

The smoke and production UI build ran as two sequential checks inside the sanctioned gate: **2 pass / 0 fail**. The build transformed 1,087 modules and completed in 17.52 seconds. [Sanitized results](live-smoke.json).

Earlier implementation's validation status (2026-10-17): the owner paused checks on this host before the selected server and UI suites completed. The resumed gate reports **skipped, treat as not run**, including typecheck and Biome. Earlier browser, smoke and build results above are historical evidence; they do not validate the final merge with main. The final typecheck, Biome, server, UI and browser suites must run in review/CI before merging.

Issue #202 follow-up: `project_link` still inspected the filesystem before confirming full local access. The setup regressions now cover missing paths and registered projects whose folders disappeared, with both approval policies. They require success without filesystem inspection, configuration writes, approvals or automatic continuation. Without the follow-up fix, a missing path returns `INVALID_ARGS` instead. The same issue also affected already linked projects: read-only and writable bots now return unchanged success after the existing path validation. The reuse/unlink regression repeats both path and project ID without additional approval, configuration or automatic continuation.

To repeat the temporary-server reproduction on Linux, run the opt-in `sidecar/test/runtime/full-local-access-live.test.ts` through the sanctioned test gate. Ensure `bun` and `bunx` are on PATH, set `TOURI_TEST_GATE` to the gate's absolute path, and run this command from the worktree in the foreground after other checks finish:

```sh
TOURI_IN_CHECK=1 TOURI_LIVE_FULL_LOCAL_QA=1 TOURI_CHECK_FRESH=1 \
TOURI_TEST_ONLY='^sidecar/test/runtime/full-local-access-live\.test\.ts$' \
"$TOURI_TEST_GATE" --all sidecar
```

This requires an installed, signed-in Codex CLI and makes real model calls. It compiles this worktree's sidecar into temporary storage, starts a loopback server with disposable data, creates a full local bot with approvals disabled and its own cwd, verifies a direct write, calls both setup tools on a missing output folder, and checks unchanged configuration and one run per message. It then stops the server, seeds legacy read-only, missing and broad grants only in the disposable database, restarts, and verifies another write and a greeting. It reads no provider credentials, prints no handshake tokens, and cleans up the server and temporary files. It does not build the UI or native shell. The recursion guard prevents nested tool-shim locking; the gate still serializes the test.

Follow-up validation (2026-10-17, main base `2ec1a47`): the setup suite has **55 pass / 0 fail**, compared with **52 pass / 3 fail** using main's implementation. Typecheck and Biome pass. The selected sidecar gate has 24 passing files and three failing files; the same four failing assertions reproduce on main in `projects/linux-process-sandbox.test.ts`, `runtime/permission-continuation.test.ts` and `security/delegation-sinks.test.ts`. There are no new failures in those files. Vitest selects no affected UI files. The fresh opt-in Linux reproduction has **1 pass / 0 fail**, covering all four messages, three exact file contents, unchanged setup configuration, no approvals or extra continuations, and successful writing after restart with legacy grants. Its temporary server and data were removed. This follow-up serves VISION promises 4, 6 and 7.
