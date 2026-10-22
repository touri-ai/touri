import { expect, test } from "bun:test"
import type { BrowserSnapshot } from "@touri/contracts"
import {
  canResumeAfterHumanTakeover,
  captureCurrentBrowserControlFrame,
  captureSafeBrowserPreview,
  sanitizeHumanTakeoverPreviewMetadata,
  sanitizeHumanTakeoverSnapshot,
} from "../../src/browser/takeover-privacy"

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
  expect(safeSnapshot.url).toBe("")
  expect(safeSnapshot.title).toBe("")
  expect(safeSnapshot.text).toBe("")
  expect(safeSnapshot.recentActions).toEqual([])
  expect(safeSnapshot.diagnostics).toEqual([])
  expect(safeSnapshot.notes).toEqual([])
  expect(safeSnapshot.focus.name).toBeNull()
  expect(safeSnapshot.elements[0]?.value).toBeUndefined()
  expect(safeSnapshot.image).toBeNull()
})

test("channel previews never capture a frame while a person controls the browser", async () => {
  const page = {
    heldByUser: true,
    privateAfterTakeover: true,
    secretMode: false,
    url: "https://travel.example.test/login",
    title: "Sign in",
  }
  let captures = 0

  const preview = await captureSafeBrowserPreview({
    getPage: () => page,
    capture: async () => {
      captures += 1
      return "fixture-image-secret"
    },
  })

  expect(preview).toBeNull()
  expect(captures).toBe(0)
})

test("a frame captured as takeover starts is discarded before it can reach channel viewers", async () => {
  let page = {
    heldByUser: false,
    privateAfterTakeover: false,
    secretMode: false,
    url: "https://travel.example.test/results",
    title: "Search results",
  }

  const preview = await captureSafeBrowserPreview({
    getPage: () => page,
    capture: async () => {
      page = { ...page, heldByUser: true, privateAfterTakeover: true }
      return "fixture-image-secret"
    },
  })

  expect(preview).toBeNull()
})

test("takeover pages stay hidden after handback until the page is safe", async () => {
  const page = {
    heldByUser: false,
    privateAfterTakeover: true,
    secretMode: false,
    url: "https://travel.example.test/payment/confirm?card=fixture-secret",
    title: "Payment",
  }
  let captures = 0

  const preview = await captureSafeBrowserPreview({
    getPage: () => page,
    capture: async () => {
      captures += 1
      return "fixture-image-secret"
    },
  })

  expect(preview).toBeNull()
  expect(captures).toBe(0)
})

test("takeover privacy can lift only after bounded metadata identifies a safe page", () => {
  expect(
    canResumeAfterHumanTakeover({
      url: "https://travel.example.test/results?query=fixture-secret",
      title: "Results",
      hasSensitiveEntry: false,
    }),
  ).toBe(true)
  expect(
    canResumeAfterHumanTakeover({
      url: "https://travel.example.test/",
      title: "Welcome",
      hasSensitiveEntry: true,
    }),
  ).toBe(false)
  expect(
    canResumeAfterHumanTakeover({
      url: "https://travel.example.test/login",
      title: "Results",
      hasSensitiveEntry: false,
    }),
  ).toBe(false)
  expect(
    canResumeAfterHumanTakeover({
      url: "https://travel.example.test/results",
      title: "Payment",
      hasSensitiveEntry: false,
    }),
  ).toBe(false)
  expect(
    canResumeAfterHumanTakeover({ url: "data:text/html,private", title: "Results", hasSensitiveEntry: false }),
  ).toBe(false)
  expect(
    canResumeAfterHumanTakeover({
      url: `https://travel.example.test/${"x".repeat(9000)}`,
      title: "Results",
      hasSensitiveEntry: false,
    }),
  ).toBe(false)
})

test("a document remains private until trusted provenance clears the hold", async () => {
  const page = {
    heldByUser: false,
    privateAfterTakeover: true,
    secretMode: false,
    url: "https://travel.example.test/results?query=fixture-secret",
    title: "Search results",
  }

  const preview = await captureSafeBrowserPreview({
    getPage: () => page,
    capture: async () => "fixture-image",
  })

  expect(preview).toBeNull()
})

test("post-takeover preview metadata omits page titles and URL values", () => {
  const metadata = sanitizeHumanTakeoverPreviewMetadata({
    url: "https://travel.example.test/results?query=fixture-secret#fixture-secret",
    title: "fixture-secret",
  })

  expect(JSON.stringify(metadata)).not.toContain("fixture-secret")
  expect(metadata).toEqual({ title: "", url: "" })
})

test("a private frame captured before navigation cannot advertise the new target epoch", async () => {
  let epoch = 4
  let complete: (frame: { image: string }) => void = () => {}
  const capture = captureCurrentBrowserControlFrame({
    getEpoch: () => epoch,
    canRead: () => true,
    capture: () =>
      new Promise<{ image: string }>((resolve) => {
        complete = resolve
      }),
  })

  epoch = 5
  complete({ image: "old-page" })

  expect(await capture).toBeNull()
})

test("revoking control discards an already running private capture", async () => {
  let held = true
  let complete: (frame: { image: string }) => void = () => {}
  const capture = captureCurrentBrowserControlFrame({
    getEpoch: () => 4,
    canRead: () => held,
    capture: () =>
      new Promise<{ image: string }>((resolve) => {
        complete = resolve
      }),
  })

  held = false
  complete({ image: "private-page" })

  expect(await capture).toBeNull()
})
