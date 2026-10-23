import { describe, expect, it } from "vitest"
import { pathLeaf, supportsHostComputer } from "../src/platform"

describe("platform capabilities", () => {
  it("offers native host computer use only on supported hosts", () => {
    expect(supportsHostComputer("Mozilla/5.0 (Macintosh; Intel Mac OS X)")).toBe(true)
    expect(supportsHostComputer("Mozilla/5.0 (Macintosh; Intel Mac OS X)", false)).toBe(false)
    expect(supportsHostComputer("Mozilla/5.0 (X11; Linux x86_64)")).toBe(false)
    expect(supportsHostComputer("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(false)
  })
  it("displays path leaves from both path syntaxes", () => {
    expect(pathLeaf("C:\\Projects\\example\\")).toBe("example")
    expect(pathLeaf("/projects/example/")).toBe("example")
  })
})
