# Native window mouse verification

Issue #224. macOS, isolated ad-hoc build, synthetic local bots `Teste` and `Sup`, and `Grupo de teste`. The installed app and its data were not used.

## Cause and change

The overlay title bar lacked `core:window:allow-start-dragging`. Bare drag-region attributes only covered the element itself, leaving decorative descendants inert, and the group header had no drag region. The top bars now use `data-tauri-drag-region="deep"`; interactive descendants still block dragging through the native framework's composed-path handling.

The webview also defaulted to `acceptFirstMouse: false`. On an inactive but visible window, a real mouse click only activated the app: neither selecting `Sup` nor opening Edit group ran until the second click. Setting `acceptFirstMouse: true` on the main window delivers that first click.

Double-click title-bar zoom uses `internal_toggle_maximize`, already allowed by `core:default`. The unrelated `allow-toggle-maximize` permission is unnecessary.

## Native evidence

Built with `bun run build:sidecar` and `bunx tauri build --bundles app`, using a configuration override for the disposable bundle identifier `ai.touri.windrag-verification`. The app had a separate temporary `TOURI_APP_DATA`. No signing identity was set; the resulting signature was ad-hoc.

A small Swift helper posted `CGEvent` mouse move, left down, left up, and a sequence of left-dragged events to `.cghidEventTap`. Window geometry came from `CGWindowListCopyWindowInfo`; captures used `screencapture -l` for this process's window. No accessibility actions or DOM-dispatched clicks were used for native verification. The first-click cases explicitly activated another app while touri remained visible on the other display.

| Check | Before | After |
| --- | --- | --- |
| First click on `Sup` | Group conversation remained open; second click selected `Sup` | First click showed `Bots / Sup` and `Mensagem para Sup` |
| First click on Edit group | Only activated the window | Opened the editor, including `Nome do grupo` |
| Sidebar top-row drag | Position stayed `(-1800, -100)` | Moved to `(-1720, -60)`, retaining `1100 × 720` |
| Group-header text drag | No drag region | Moved to `(-1616, -20)`, retaining `1100 × 720` |
| Bot-header text drag | Decorative text was outside the drag region | Moved to `(-1571, 5)`, retaining `1100 × 720` |
| Double click group title | Group header had no drag region | Zoomed to `1920 × 1050`, filling the display's visible frame |
| Double click sidebar top row | Dragging was unavailable | Restored the normal `1100 × 720` window |

Screenshots: [ignored first click before](before-first-click.png), [first click opens Sup](after-first-click-sup.png), [first click opens editor](after-first-click-edit.png), [header after dragging](after-header-drag.png), [title zoom](after-title-zoom.png). The Sup image is the top portion of the unmodified window capture; the other images are full window captures.

## Checks

- `bun install --frozen-lockfile`: actual dependencies installed in both the branch and separate baseline worktrees.
- `bunx biome check .`: passed.
- `bun run typecheck`: passed.
- `bun --cwd ui build`: passed through the native build's normal build hook.
- New configuration/UI tests: 3 passed; the permission, first-mouse and drag-region assertions failed before their changes.
- Mouse hit-testing regression plus existing sidebar/group e2e: 7 passed, with motion enabled in the new regression. It clicks text, avatars, a header toggle, Edit group, and the sidebar search icon using pointer down/up, and checks the hit target for overlays.
- Full UI suite: 1440 passed, 6 failed. A separate baseline checkout reproduced the same six failures: three stale access-description assertions, one long-history composer fixture timeout, and two lazy approval-card timeouts. Follow-ups include #228 and #229.
- `bun test sidecar/test/groups sidecar/test/store`: 123 passed, 2 failed on both the branch and baseline. The existing failures concern delegation arguments and transcript checkpointing. No sidecar code changed.

VISION promise 7: calm, clear, native. Moving a window and selecting its controls now behave like ordinary Mac interactions.
