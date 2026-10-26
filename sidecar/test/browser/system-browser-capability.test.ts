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

test("a crashed browser during the protocol handshake remains a test failure", async () => {
  const fixture = getProbeFixture({ exitCode: 137 })

  await expect(getBrowserProbeCapability(fixture)).rejects.toThrow("System browser capability probe failed (exit 137)")

  expect(fixture.stops.size).toBe(1)
})

test("a responsive browser without a working renderer cannot pass the sandbox probe", async () => {
  const fixture = getProbeFixture({ rendererReady: false })

  await expect(getBrowserProbeCapability(fixture)).rejects.toThrow("System browser capability probe failed (exit 137)")

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
  expect(() => getBrowserSandboxCapability(137, "")).toThrow("System browser capability probe failed (exit 137)")
})

const getProbeFixture = ({ exitCode = 0, stderr = "", rendererReady = true } = {}) => {
  const exited = Promise.withResolvers<{ code: number }>()
  const input = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
  const commands = new Set<string>()
  const stops = new Set<string>()
  const read = new ReadableStream<Uint8Array>({ start: (controller) => input.resolve(controller) })
  const write = new WritableStream<Uint8Array>({
    write: async (bytes) => {
      const command = JSON.parse(new TextDecoder().decode(bytes).replace(/\0$/u, "")) as { id: number; method: string }
      commands.add(command.method)
      const controller = await input.promise
      if (exitCode !== 0) {
        exited.resolve({ code: exitCode })
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
