Data setup was audited against main at `447e64c`, including the existing folder browser (#141) and connection tests (#137). Issue: #143.

| Viewport | Device/server choices | Server folder browser |
| --- | --- | --- |
| 390 × 844 | [Before](before-390-choices.png) · [After](after-390-choices.png) | [Before](before-390-folders.png) · [After](after-390-folders.png) |
| 1440 × 900 | [Before](before-1440-choices.png) · [After](after-1440-choices.png) | [Before](before-1440-folders.png) · [After](after-1440-folders.png) |

Screenshots render the real App with a deterministic mock API, neutral server paths and no personal data. The mobile folder dialog now escapes the settings panel's clipping, keeps touch targets usable, and identifies its actual location.

| Behavior | Automated evidence |
| --- | --- |
| Device upload differs from server selection; touch, Tab/Enter, cancellation and explicit read-only selection | `ui/test/e2e/data-access.spec.ts`, `ui/test/folder-picker.test.tsx` |
| No unsupported grant or automatic task submission; upload preserves the draft | `ui/test/e2e/data-access.spec.ts`, `ui/test/connect-data.test.tsx` |
| Root boundaries, protected folders, external links and directory replacement | `sidecar/test/projects/folders.test.ts` |
| Actual uploaded CSV rows reach provider input; unreadable data is never silently truncated | `sidecar/test/store/attachments.test.ts`, `sidecar/test/runtime/csv-input.test.ts`, `sidecar/test/runtime/runtime.test.ts` |
| Missing-data instructions forbid invented records across providers | `sidecar/test/runtime/data-connection.test.ts` |
| Technical prerequisites stay behind the technical option; saving requires a successful connection test; returning sends no message | `ui/test/mcp-catalog.test.tsx`, `ui/test/e2e/data-access.spec.ts` |
| Portuguese and English choices | `ui/test/data-access-copy.test.ts` |

The new CSV-to-provider regression fails on the audited main: the provider receives only the question. The new root-boundary regression also fails there: an outside directory returns HTTP 200 instead of rejection.

Conservative choices: the server's personal folder is the browsing root; additional roots need an explicit allowlist. Folder grants use the current host provider's capability check, so an unsupported Linux host offers upload instead of persisting an unusable grant. This does not introduce a Linux isolation implementation. CSV input is UTF-8 and bounded to 256 KiB across attachments; larger or unreadable tables request a smaller upload, without partial rows. Technical connection tests verify the server's announced tools; source-specific authorization remains part of the task. No built-in direct connector is claimed.
