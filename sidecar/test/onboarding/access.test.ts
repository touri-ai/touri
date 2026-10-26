import { expect, test } from "bun:test"
import { exposeOnTailscale, type RunCommand, runCommand, stopTailscaleAccess } from "../../src/cli/tailscale"

const getRun = (configuration: unknown, code = 0) => {
  const calls: Array<Array<string>> = []
  const run: RunCommand = async (_command, args) => {
    calls.push(args)
    if (args[0] === "status") return { code: 0, stdout: '{"Self":{"DNSName":"studio.example.ts.net."}}', stderr: "" }
    if (args[1] === "status") return { code, stdout: JSON.stringify(configuration), stderr: "" }
    return { code: 0, stdout: "", stderr: "" }
  }
  return { run, calls }
}
const getConfiguration = (port: number) => ({
  Web: { "studio.example.ts.net:8445": { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } },
})

test("restores only its recorded handler after the desktop runtime gets a new port", async () => {
  const { run, calls } = getRun(getConfiguration(18841))

  const result = await exposeOnTailscale({ localPort: 18842, previousLocalPort: 18841, run })

  expect(result.success).toBe(true)
  expect(calls.at(-1)).toEqual(["serve", "--bg", "--https=8445", "http://127.0.0.1:18842"])
})

test("never replaces an unrelated handler or an unreadable configuration", async () => {
  const foreign = getRun(getConfiguration(18843))
  const unreadable = getRun({}, 1)
  const invalid = getRun(null)

  expect((await exposeOnTailscale({ localPort: 18842, previousLocalPort: 18841, run: foreign.run })).success).toBe(
    false,
  )
  expect((await exposeOnTailscale({ localPort: 18842, run: unreadable.run })).success).toBe(false)
  expect((await exposeOnTailscale({ localPort: 18842, run: invalid.run })).success).toBe(false)
  expect([foreign, unreadable, invalid].some(({ calls }) => calls.some((args) => args.includes("--bg")))).toBe(false)
})

test("disables private access only when the handler belongs to this runtime", async () => {
  const own = getRun(getConfiguration(18841))
  const foreign = getRun(getConfiguration(18842))

  expect(await stopTailscaleAccess(18841, own.run)).toBe(true)
  expect(await stopTailscaleAccess(18841, foreign.run)).toBe(false)
  expect(own.calls.at(-1)).toEqual(["serve", "--https=8445", "off"])
  expect(foreign.calls.some((args) => args.includes("off"))).toBe(false)
})

test("cancels a CLI process and drains both output streams", async () => {
  const started = performance.now()

  const result = await runCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], AbortSignal.timeout(50))

  expect(result.code).toBe(124)
  expect(performance.now() - started).toBeLessThan(3000)
})

test.each([
  { TCP: { "8445": { TCPForward: "127.0.0.1:18843" } } },
  { Foreground: { session: getConfiguration(18843) } },
  { Web: { "studio.example.ts.net:8445": { Handlers: null } } },
])("preserves existing forwards and malformed handler configurations", async (configuration) => {
  const { run, calls } = getRun(configuration)

  const result = await exposeOnTailscale({ localPort: 18842, run })

  expect(result.success).toBe(false)
  expect(calls.some((args) => args.includes("--bg"))).toBe(false)
})
