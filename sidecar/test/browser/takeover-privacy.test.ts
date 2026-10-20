import { expect, test } from "bun:test"
import type { BrowserSnapshot } from "@touri/contracts"
import { sanitizeHumanTakeoverSnapshot } from "../../src/browser/takeover-privacy"

test("human takeover snapshots omit typed field values, page images, and URL secrets", () => {
  const snapshot: BrowserSnapshot = {
    tabId: "browser-tab",
    generation: 4,
    url: "https://travel.example.test/login/fixture-secret?token=fixture-secret#fixture-secret",
    title: "fixture-secret",
    loading: false,
    viewport: { width: 1280, height: 720, scrollY: 0, scrollHeight: 720 },
    focus: { ref: "4.1", role: "textbox", name: "fixture-secret" },
    elements: [
      {
        ref: "4.1",
        role: "textbox",
        name: "Account number",
        value: "fixture-secret",
        states: ["focused"],
        frame: "main",
        inViewport: true,
      },
    ],
    text: "fixture-secret",
    truncated: false,
    image: { dataUrl: "data:image/jpeg;base64,fixture-secret", reason: "requested" },
    recommendImage: "requested",
    recentActions: [
      { at: 1, tool: "browser_type", target: "fixture-secret", ok: true, errorCode: null, note: "fixture-secret" },
    ],
    diagnostics: [{ at: 1, kind: "network", level: "info", text: "fixture-secret" }],
    heldByUser: false,
    notes: ["fixture-secret"],
  }

  const safeSnapshot = sanitizeHumanTakeoverSnapshot(snapshot)

  expect(JSON.stringify(safeSnapshot)).not.toContain("fixture-secret")
  expect(safeSnapshot.url).toBe("https://travel.example.test")
  expect(safeSnapshot.title).toBe("")
  expect(safeSnapshot.text).toBe("")
  expect(safeSnapshot.recentActions).toEqual([])
  expect(safeSnapshot.diagnostics).toEqual([])
  expect(safeSnapshot.notes).toEqual([])
  expect(safeSnapshot.focus.name).toBeNull()
  expect(safeSnapshot.elements[0]?.value).toBeUndefined()
  expect(safeSnapshot.image).toBeNull()
})
