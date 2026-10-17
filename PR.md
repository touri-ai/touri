fix(folders): browse bot and project folders without typing server paths

## Problem

Adding a bot folder or choosing another project folder opened a server-path prompt in the web UI. Projects were hidden under Advanced, and additional folder permissions were not offered in the picker. UI tests still assumed write access by default after review restored the read-only default.

## Fix

- Add authenticated `GET /folders` and `POST /folders` routes with a shared API type and JSON schema. Start at the server user's home, return folders only, hide dotfolders, refuse application data and all existing sensitive exclusions, and cap listings at 100 folders and 2,000 scanned entries.
- Reject traversal and symbolic links, including intermediate components and canonical sensitive aliases. Pin directories with the existing no-follow filesystem helpers; use `mkdirat` for a single new child and recheck directory identity before responding.
- Reuse one folder dialog for bot folders and projects in desktop and served web UI: breadcrumbs, folder list, confirmed creation, secondary “Digitar caminho”, optional native Mac chooser, and explicit “O bot pode ler” / “O bot pode ler e salvar arquivos aqui” permissions. New additional folders are read-only by default, with an explicit write choice; general bot permissions and approvals still apply. If a bot later needs to write into a read-only folder, the existing write-approval upgrade path asks once (`Permitir escrita em <pasta>?`) and continues automatically after approval. Read-only project choices use existing folder restrictions; writable projects retain their existing project access.
- Test default read-only grants through navigation, typed paths, bot creation, project connection, and settings; select writing explicitly in tests that need it. Cover saving both the untouched default and an explicit write choice in bot folder settings.
- Show project selection and “Usar uma pasta” before Advanced. Preserve folder choices in bot creation and settings.

## Evidence

- Follow-up verification from `ui/`: `bunx vitest run --maxWorkers=2 --testTimeout=15000 test/folder-picker.test.tsx test/folder-picker-flow.test.tsx test/bot-folders.test.tsx test/project-discovery.test.tsx test/create-bot.test.tsx test/composer-project.test.tsx`: **66 passed across 6 files**, including a new default read-only settings case. Before updating the tests: **6 failed, 59 passed**, all failures expecting implicit write access.
- Default-access regression proof from `ui/`: `bunx vitest run --maxWorkers=2 --testTimeout=15000 test/bot-folders.test.tsx -t 'adds a folder through the shared picker with read-only access and saves it'`: **1 failed, 12 skipped** when temporarily restoring `BotFolderSettings` to `initialAccess="read-write"`. Restored the read-only default before the passing full focused run above.
- `bun test sidecar/test/projects/folders.test.ts sidecar/test/kernel/files.test.ts`: **30 passed** (11 endpoint tests plus 19 existing filesystem tests). Covers listing, bounds, all exclusions, traversal, symlinks, directory swaps during listing/creation, creation failures, and API response schema.
- From `ui/`: `bunx vitest run --maxWorkers=2 --testTimeout=15000 test/folder-picker.test.tsx test/folder-picker-flow.test.tsx test/bot-folders.test.tsx test/project-discovery.test.tsx test/composer-project.test.tsx test/create-bot.test.tsx test/api-client.test.ts test/settings-simplification.test.tsx test/connect-data.test.tsx test/r2-regressions.test.tsx`: **109 passed**. The longer per-test timeout accommodates concurrent machine load; two existing tests exceeded five seconds in an earlier run and passed on rerun.
- Earlier focused verification from `ui/`: `bunx vitest run --maxWorkers=2 --testTimeout=15000 test/bot-folders.test.tsx test/project-discovery.test.tsx test/folder-picker-flow.test.tsx`: **26 passed**, including the additional read-only project regression after naming the project and saving settings. The earlier relevant runs cover **110 distinct UI tests**.
- Regression proof: copy `ui/test/folder-picker-flow.test.tsx` into a temporary `origin/main` checkout and run `bunx vitest run --maxWorkers=2 test/folder-picker-flow.test.tsx`: **2 failed before, 2 passed after** (simple-flow visibility and project folder browsing).
- `bunx tsc --noEmit -p tsconfig.base.json`: **passed**, no diagnostics.
- `bunx biome check <changed TS/TSX/CSS/JSON files>`: **19 files checked, no errors**, with no fixes needed. One existing warning remains for the unused `readOnly` parameter in `BotFolderSettings.tsx`.
- `git diff --check`: clean.
- Endpoint tests use the real route registry. Live HTTP setup failed in this environment (`EADDRINUSE`); Chromium startup was denied (`Operation not permitted`), so a screenshot could not be captured. Native macOS behavior could not be exercised on Linux.

VISION promises served: **#7, Calm, clear, native**, through discoverable navigation and plain Portuguese permissions; **#4, The user is in charge**, through explicit folder grants and confirmation before creation. All operations stay local (**#1, Your machine, your data**).
