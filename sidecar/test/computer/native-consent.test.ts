import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const rust = (path: string) => readFileSync(join(import.meta.dir, "../../../src-tauri/src", path), "utf8")

test("C-01: rejected preview navigation never invokes an OS URL handler", () => {
  const source = rust("preview.rs")
  const callback = source.slice(
    source.indexOf(".on_navigation"),
    source.indexOf("window\n", source.indexOf(".on_navigation")),
  )
  expect(callback).not.toContain("open_external")
  expect(source.slice(source.indexOf("pub fn open_external"))).toContain("parse_external_url(url)?")
})

test("C-10: every preview IPC resolves an owned handle and requires the main caller", () => {
  const source = rust("lib.rs")
  for (const command of ["preview_set_bounds", "preview_navigate", "preview_reload", "preview_hide"]) {
    const start = source.indexOf(`fn ${command}(`)
    const body = source.slice(start, source.indexOf("#[tauri::command]", start))
    expect(body).toContain("preview::owned_preview(")
    expect(body).not.toContain("get_webview(&label)")
  }
})

test("B03: native events recheck the protected input target at the posting boundary", () => {
  const source = rust("platform/macos/computer_input.rs")
  expect(source).toContain("CGWindowListCopyWindowInfo")
  expect(source).toContain("frontmostApplication")
  for (const statement of source.matchAll(/([a-z_]+)\.post\(CGEventTapLocation::HID\)/g)) {
    expect(source.slice(Math.max(0, (statement.index ?? 0) - 200), statement.index)).toContain("guard_target(")
  }
})

test("B03: a local native event filter rejects marked synthetic events even after a focus race", () => {
  const source = rust("platform/macos/computer_input.rs")
  expect(source).toContain("addLocalMonitorForEventsMatchingMask")
  expect(source).toContain("EVENT_SOURCE_USER_DATA")
  expect(rust("computer/mod.rs")).toContain("input::install_consent_guard()")
})
