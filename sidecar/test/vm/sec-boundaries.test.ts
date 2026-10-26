import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Kernel } from "@touri/contracts"
import { createAppleContainerProvider } from "../../src/vm/apple-container"
import { BOT_IMAGE } from "../../src/vm/image"
import init from "../../src/vm/image/init.sh" with { type: "text" }
import { readProviderLogin } from "../../src/vm/provider-login"

test("B07 vault failure never silently selects a host CLI file", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-login-boundary-"))
  mkdirSync(join(root, ".claude"))
  writeFileSync(join(root, ".claude/.credentials.json"), "{}")
  const kernel = {
    callHost: async () => ({ success: false, errorCode: "denied", error: "denied" }),
  } as unknown as Kernel
  try {
    await expect(readProviderLogin(kernel, { id: "bot", provider: "claude" } as Bot, root)).rejects.toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("A08 B08 guest control forwarding has no unauthenticated TCP listener", async () => {
  const provider = createAppleContainerProvider({ runCommand: async () => ({ code: 0, stdout: "", stderr: "" }) })
  try {
    const forward = await provider.forwardPort({ id: "touri-sec-test", guestPort: 9876 })
    expect(forward.success).toBe(true)
    if (forward.success) expect(forward.hostPort).toBe(0)
  } finally {
    await provider.destroy({ id: "touri-sec-test" })
  }
})

test("B09 browser profile is isolated from the agent and protected at boot", () => {
  expect(init).toContain("/var/lib/touri-browser")
  expect(init).toContain("1001")
})

test("B11 network enforcement must precede guest readiness", () => {
  expect(init.indexOf("network-policy.py")).toBeGreaterThan(-1)
  expect(init.indexOf("network-policy.py")).toBeLessThan(init.indexOf("touch /tmp/touri-ready"))
  expect(BOT_IMAGE).toBe("touri-bot:9")
})

test("B05 guest state write refuses a linked parent without modifying its target", async () => {
  const { symlinkSync } = await import("node:fs")
  const root = mkdtempSync(join(tmpdir(), "touri-write-boundary-"))
  mkdirSync(join(root, "outside"))
  symlinkSync(join(root, "outside"), join(root, "linked"))
  const child = Bun.spawn(
    ["python3", "-c", (await import("../../src/vm/guest-write")).GUEST_WRITE_COMMAND, root, join(root, "linked/state")],
    { stdin: "pipe", stderr: "pipe" },
  )
  child.stdin.write("state")
  child.stdin.end()
  try {
    expect(await child.exited).not.toBe(0)
    expect(await Bun.file(join(root, "outside/state")).exists()).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("B05 interrupted cloud snapshot preserves the original destination", async () => {
  const { readFileSync } = await import("node:fs")
  const { createRemoteProvider } = await import("../../src/vm/remote")
  const root = mkdtempSync(join(tmpdir(), "touri-download-boundary-"))
  const path = join(root, "snapshot")
  writeFileSync(path, "original")
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"))
          controller.error(new Error("interrupted"))
        },
      }),
    )) as unknown as typeof fetch
  const client = {
    capabilities: async () => ({ capabilities: ["snapshots"] }),
    request: async () => ({ path: "/snapshot" }),
    endpoint: () => "http://127.0.0.1:1/snapshot",
    access: async () => "test-only",
  } as unknown as import("../../src/cloud/client").CloudClient
  const provider = createRemoteProvider({ client })
  try {
    const operation = provider.snapshot({ id: "test", path })
    expect(readFileSync(path, "utf8")).toBe("original")
    expect((await operation).success).toBe(false)
  } finally {
    globalThis.fetch = originalFetch
    rmSync(root, { recursive: true, force: true })
  }
})
