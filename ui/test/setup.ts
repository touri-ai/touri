import { configure } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, vi } from "vitest"

configure({ asyncUtilTimeout: 10_000 })

afterEach(() => localStorage.clear())

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
})

Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: () => null,
})

// Native permission fixtures emulate a supported host without changing keyboard platform detection.
vi.mock("../src/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/platform")>()),
  hostComputerSupported: true,
}))
