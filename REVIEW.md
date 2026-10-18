# Review instructions

These rules drive both Claude Code Review on pull requests and the touri review bot that triages
pull requests and issues. CI and Biome already enforce formatting, lint and types: never report those.

## Severity

- 🔴 **Important**: the change breaks behaviour a user relies on, loses or leaks data, weakens a
  security boundary (folder access, approvals, sandbox, vault, pairing, credentials), or blocks an
  upgrade or rollback. Every Important finding cites the `file:line` that proves it.
- 🟡 **Nit**: worth fixing, not blocking. Report at most five per review.
- 🟣 **Pre-existing**: a real bug the pull request did not introduce. Report it once, never as a blocker.

Style, naming and refactoring suggestions are Nit at most.

## Risk tiers (who may merge)

`scripts/pr-risk.ts` sets the tier from the changed paths and size; a review may only make it stricter.

| Tier | What | Merge |
| :- | :- | :- |
| **merge** | Styles, small presentational component changes (≤ 60 lines per component, ≤ 150 in total), tests, docs, image assets, from a maintainer, not a draft, not a fork | The review bot merges once checks are green and its review has no 🔴 |
| **review** | New features (`feat`), runtime code (sidecar, API contracts, UI state and data), larger diffs, outside authors, forks, drafts | A maintainer approves; the bot posts its review and pings the Review group |
| **danger** | Native shell (`src-tauri`), CI and release scripts, dependencies, storage schema, security and access-control code, the `security` or `needs-maintainer` label, these rules themselves | A maintainer reviews line by line; the bot never merges and flags it at the top of the Review group |

A merge-tier change stops being merge-tier when the review finds that a "visual" change also alters
behaviour (event handlers, data flow, conditions that hide or show controls, accessibility names).

## Always check

- User-facing strings exist in pt-BR and en.
- No personal data, secrets or real conversation content in code, fixtures or logs.
- A bug fix comes with a test that fails without it.
- Approval, folder-access and sandbox changes keep the default deny.

## Do not report

- Formatting, lint and type errors (CI enforces them).
- Generated files, lockfiles, screenshots and baselines under `ui/test/e2e/`.
