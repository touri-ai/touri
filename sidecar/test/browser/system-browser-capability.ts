import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCdpClient } from "../../src/browser/cdp"
import type { CdpPipe } from "../../src/browser/types"
import { spawnTree } from "../../src/kernel/spawn"

type Capability = { available: true } | { available: false; reason: string }

export const getSystemBrowserCapability = async (): Promise<Capability> => {
  if (process.platform !== "linux") return { available: false, reason: "Linux headful fixture only" }
  const executable = Bun.which("google-chrome")
  if (!executable) return { available: false, reason: "Stable system browser is not installed" }
  if (!Bun.which("Xvfb")) return { available: false, reason: "Virtual display is not installed" }

  const root = await mkdtemp(join(tmpdir(), "touri-browser-capability-"))
  const child = spawnTree({
    cmd: executable,
    args: [`--user-data-dir=${root}`, "--headless=new", "--no-first-run", "--remote-debugging-pipe", "about:blank"],
    cwd: root,
    env: { PATH: process.env.PATH ?? "", HOME: root },
    extraFds: 2,
  })
  if (!child.success) {
    await rm(root, { recursive: true, force: true })
    throw new Error("System browser capability probe could not start")
  }
  const diagnostics = new Response(child.stderr).text()
  const output = child.stdout.pipeTo(new WritableStream<Uint8Array>())
  try {
    const write = child.extra[0]?.write
    const read = child.extra[1]?.read
    if (!read || !write) throw new Error("System browser capability pipe is unavailable")

    return await getBrowserProbeCapability({
      pipe: { read, write },
      exited: child.exited,
      diagnostics,
      stop: () => child.kill("SIGKILL"),
    })
  } finally {
    child.kill("SIGKILL")
    await Promise.all([child.exited, diagnostics, output])
    await rm(root, { recursive: true, force: true })
  }
}

export const getBrowserProbeCapability = async ({
  pipe,
  exited,
  diagnostics,
  stop,
  timeoutMs = 5_000,
}: {
  pipe: CdpPipe
  exited: Promise<{ code: number | null; signal?: string | null }>
  diagnostics: Promise<string>
  stop: () => void
  timeoutMs?: number
}): Promise<Capability> => {
  const client = createCdpClient({ pipe, timeoutMs })
  // Keep the natural exit distinct from the signal sent by our own cleanup.
  let naturalExit: { code: number | null; signal?: string | null } | undefined
  const processExit = exited.then((result) => {
    naturalExit = result
    return result
  })
  let timedOut = false
  const deadline = setTimeout(() => {
    timedOut = true
    stop()
    void client.close().catch(() => undefined)
  }, timeoutMs)
  try {
    // Execute in a renderer to verify its sandbox, without waiting for page dumping or browser shutdown.
    const { targetId } = await client.call<{ targetId: string }>("Target.createTarget", { url: "about:blank" })
    const { sessionId } = await client.call<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })
    const result = await client.call<{ result: { value: number } }>(
      "Runtime.evaluate",
      { expression: "1", returnByValue: true },
      sessionId,
    )
    if (result.result.value !== 1) throw new Error("System browser renderer did not respond")

    return { available: true }
  } catch (error) {
    const probeTimedOut = timedOut
    // Pipe EOF and process exit notifications can arrive in either order.
    const exit = naturalExit ?? (client.isClosed() && !probeTimedOut ? await processExit : undefined)
    clearTimeout(deadline)
    stop()
    const [, stderr] = await Promise.all([processExit, diagnostics])
    if (probeTimedOut) return { available: false, reason: "System browser probe exceeded its startup deadline" }
    // Cleanup after a disconnected pipe must not disguise the original protocol failure.
    if (timedOut) throw error
    if (!exit) throw error
    if (exit.code === null) {
      if (["SIGKILL", "SIGTERM", "9", "15"].includes(exit.signal ?? ""))
        return { available: false, reason: `System browser probe was terminated (signal ${exit.signal})` }
      throw new Error(`System browser capability probe failed (signal ${exit.signal ?? "unknown"})`)
    }
    const capability = getBrowserSandboxCapability(exit.code, stderr)
    if (capability.available) throw error

    return capability
  } finally {
    clearTimeout(deadline)
    stop()
    await Promise.all([client.close(), exited, diagnostics])
  }
}

export const getBrowserSandboxCapability = (exitCode: number, diagnostics: string): Capability => {
  if (exitCode === 0) return { available: true }
  if (/No usable sandbox|Failed to move to new namespace|Running as root without --no-sandbox/u.test(diagnostics))
    return { available: false, reason: "Host cannot start the system browser with its sandbox enabled" }
  if ([124, 137, 143].includes(exitCode))
    return { available: false, reason: `System browser probe was killed (exit ${exitCode})` }

  throw new Error(`System browser capability probe failed (exit ${exitCode})`)
}
