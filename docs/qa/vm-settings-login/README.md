# VM login after settings saves

Issue: [#195](https://github.com/touri-ai/touri/issues/195). Base: `21fd9c8`.

## Real end-to-end check

Tested on macOS 26, arm64, with a real Linux VM and this Mac's existing Codex login. The UI used the production build and the actual sidecar modules, served locally by a disposable test bootstrap with VM support enabled. All bot data, login-source settings and temporary secret storage belonged to that bootstrap. The installed desktop app and its data were not used. This is a real UI/provider/VM check, not a packaged-desktop retest.

On the base revision:

1. Create **QA VM**, choose the isolated Linux machine, leave the browser enabled, and adopt the available host login.
2. Ask the bot to open a public page. It opens the page and the run succeeds.
3. Open advanced computer settings. The login switch incorrectly displays off even though the backend has `vmProviderLogin=true`.
4. Turn off only the browser and save settings. The backend now has both flags false; the machine ID is unchanged.
5. Send a greeting. The run fails with `cli_auth`, saying Codex is not connected in this machine. [Failure screenshot](before.png).

With the fix, using a newly created **QA VM corrigido**:

1. A greeting succeeds. The settings dialog correctly shows login enabled.
2. Turn off only the browser and save. Login stays enabled and browser access stays disabled.
3. Send another greeting. The same VM answers **login preservado.** [After-save screenshot](after-save.png).
4. Request a public page and explicitly ask for browser approval if necessary. The **Ativar navegador** approval card appears. [Approval screenshot](approval.png).
5. Click **Ativar** once. The original task resumes automatically and opens the requested page. Both the request run and its continuation succeed; login and browser access are enabled and the VM ID is unchanged. No login action occurs between these steps. [Completed continuation](resumed.png).

The two disposable machines and their volumes are removed after verification. No production bot data or host credential is modified.

## Cause and regression coverage

Login adoption enables the backend flag after `POST /bots`. Workspace creation then used the earlier response to overwrite the newer bot state. The settings dialog separately retained its initial machine fields and sent every field on unrelated saves. That stale `false` was an explicit opt-out, so VM credential revocation behaved correctly; no VM replacement or home-volume loss was involved.

Creation now reloads the canonical bot after adoption and retains event state if that refresh fails. Machine settings retain only deliberate edits; untouched fields follow the current bot and are omitted from PATCH. Explicit login opt-out and provider changes still send their intended login change.

- UI regressions exercise adoption with and without an event subscription, a login completed while settings are open, browser/save, and explicit login opt-out. The adoption and stale-dialog regressions fail against the base implementation.
- The store unit test exercises the real PATCH handler and capability configuration path, checking login preservation, explicit opt-out and absence of a machine stop.
- No user-facing string was added or changed.

## Validation results

Checks ran one suite at a time. Each worktree had a real frozen-lockfile install.

| Check | Result |
| --- | --- |
| Biome | Passed; one existing unused-parameter warning |
| Typecheck | Passed |
| UI suite | 1,367 passed with two workers |
| Store suite | 62 passed |
| VM suite | 387 passed, 18 optional integrations skipped |
| Capability/project suite | 99 passed |
| Production UI build | Passed; existing bundle-size warning |
| Regression tests against the base | Three fail, explicit opt-out control passes |

The first full UI run had three timing failures in two existing files; all 16 tests in those files passed focused checks on both revisions, and the complete two-worker run passed. An initial store restart timeout also did not recur: the branch passed 62 tests and the base passed 61. Sidecar suites used the CI's Bun 1.4.3 runtime. The real VM check above was performed separately from the optional integration suite.
