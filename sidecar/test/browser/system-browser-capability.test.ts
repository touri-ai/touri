import { expect, test } from "bun:test"
import { getBrowserProbeCapability, getBrowserSandboxCapability } from "./system-browser-capability"

test("a sandboxed renderer is ready on its protocol reply before process exit", async () => {
  const fixture = getProbeFixture()

  const capability = await getBrowserProbeCapability(fixture)

  expect(capability).toEqual({ available: true })
  expect(Array.from(fixture.commands)).toEqual(["Target.createTarget", "Target.attachToTarget", "Runtime.evaluate"])
  expect(fixture.stops.size).toBe(1)
  expect(await fixture.exited).toEqual({ code: 137 })
})

test("a sandbox refusal during the protocol handshake remains an explicit capability failure", async () => {
  const fixture = getProbeFixture({ exitCode: 1, stderr: "Failed to move to new namespace" })

  const capability = await getBrowserProbeCapability(fixture)

  expect(capability).toEqual({
    available: false,
    reason: "Host cannot start the system browser with its sandbox enabled",
  })
  expect(fixture.stops.size).toBe(1)
})

test("a killed browser during the protocol handshake explains the skipped integration", async () => {
  const fixture = getProbeFixture({ exitCode: 137 })

  const capability = await getBrowserProbeCapability(fixture)

  expect(capability).toEqual({ available: false, reason: "System browser probe was killed (exit 137)" })
  expect(fixture.stops.size).toBe(1)
})

test("a responsive browser without a working renderer cannot pass the sandbox probe", async () => {
  const fixture = getProbeFixture({ rendererReady: false })

  await expect(getBrowserProbeCapability(fixture)).rejects.toThrow("System browser renderer did not respond")

  expect(Array.from(fixture.commands)).toContain("Runtime.evaluate")
  expect(fixture.stops.size).toBe(1)
})

test("a successful sandboxed browser probe enables the persistence regression", () => {
  expect(getBrowserSandboxCapability(0, "")).toEqual({ available: true })
})

test("an explicit sandbox capability failure explains the skipped integration", () => {
  expect(getBrowserSandboxCapability(1, "Failed to move to new namespace")).toEqual({
    available: false,
    reason: "Host cannot start the system browser with its sandbox enabled",
  })
})

test("unknown browser failures remain test failures", () => {
  expect(() => getBrowserSandboxCapability(1, "Unexpected startup failure")).toThrow(
    "System browser capability probe failed (exit 1)",
  )
})

test.each([124, 137, 143])("a killed or expired capability probe reports exit %s", (exitCode) => {
  expect(getBrowserSandboxCapability(exitCode, "")).toEqual({
    available: false,
    reason: `System browser probe was killed (exit ${exitCode})`,
  })
})

test("a startup deadline kills the probe and reports an explicit capability reason", async () => {
  const fixture = getProbeFixture({ unresponsive: true })

  const capability = await getBrowserProbeCapability(Object.assign({}, fixture, { timeoutMs: 25 }))

  expect(capability).toEqual({ available: false, reason: "System browser probe exceeded its startup deadline" })
  expect(fixture.stops.size).toBe(1)
})

test("slow cleanup cannot turn a renderer failure into a capability timeout", async () => {
  const fixture = getProbeFixture({ rendererReady: false })
  const diagnostics = new Promise<string>((resolve) => setTimeout(() => resolve(""), 60))

  const probe = getBrowserProbeCapability(Object.assign({}, fixture, { diagnostics, timeoutMs: 25 }))

  await expect(probe).rejects.toThrow("System browser renderer did not respond")
})

test.each(["SIGKILL", "SIGTERM"])("external termination by %s reports a capability reason", async (signal) => {
  const fixture = getProbeFixture({ exitCode: null, signal })

  const capability = await getBrowserProbeCapability(fixture)

  expect(capability).toEqual({ available: false, reason: `System browser probe was terminated (signal ${signal})` })
})

test.each(["SIGSEGV", "SIGABRT"])("browser crash signal %s remains a failure", async (signal) => {
  const fixture = getProbeFixture({ exitCode: null, signal })

  await expect(getBrowserProbeCapability(fixture)).rejects.toThrow(
    `System browser capability probe failed (signal ${signal})`,
  )
})

const getProbeFixture = ({
  exitCode = 0,
  stderr = "",
  rendererReady = true,
  unresponsive = false,
  signal = null,
}: {
  exitCode?: number | null
  stderr?: string
  rendererReady?: boolean
  unresponsive?: boolean
  signal?: string | null
} = {}) => {
  const exited = Promise.withResolvers<{ code: number | null; signal?: string | null }>()
  const input = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
  const commands = new Set<string>()
  const stops = new Set<string>()
  const read = new ReadableStream<Uint8Array>({ start: (controller) => input.resolve(controller) })
  const write = new WritableStream<Uint8Array>({
    write: async (bytes) => {
      const command = JSON.parse(new TextDecoder().decode(bytes).replace(/\0$/u, "")) as { id: number; method: string }
      commands.add(command.method)
      if (unresponsive) return
      const controller = await input.promise
      if (exitCode !== 0) {
        exited.resolve({ code: exitCode, signal })
        controller.close()
        return
      }

      const results = {
        "Target.createTarget": { targetId: "probe-target" },
        "Target.attachToTarget": { sessionId: "probe-session" },
        "Runtime.evaluate": { result: { value: rendererReady ? 1 : 0 } },
      }
      const result = results[command.method as keyof typeof results]
      controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ id: command.id, result })}\0`))
    },
  })

  return {
    pipe: { read, write },
    exited: exited.promise,
    diagnostics: Promise.resolve(stderr),
    commands,
    stops,
    stop: () => {
      stops.add("stopped")
      exited.resolve({ code: 137 })
    },
  }
}
