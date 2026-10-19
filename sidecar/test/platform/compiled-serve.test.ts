import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { removeSmokeDirectory } from "../../../scripts/smoke-cleanup"

const cleanups = new Set<() => Promise<unknown>>()
afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

test("the compiled CLI starts serve, pairs a device and durably revokes it", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-compiled-serve-"))
  cleanups.add(() => removeSmokeDirectory(root))
  const binary = join(root, process.platform === "win32" ? "fixture.exe" : "fixture")
  const repository = resolve(import.meta.dir, "../../..")
  const entries = ["main", "file-io-worker-entry", "auth-writer-worker-entry", "atomic-download-worker-entry"]
  const target = process.platform === "linux" && process.arch === "x64" ? ["--target=bun-linux-x64-baseline"] : []
  const build = await getCommandOutput(
    [
      process.execPath,
      "build",
      "--compile",
      ...target,
      ...entries.map((entry) => join(repository, "sidecar/src/cli", `${entry}.ts`)),
      "--outfile",
      binary,
    ],
    root,
  )
  expect(build.code).toBe(0)
  const dataDir = join(root, "data")
  const args = ["--data-dir", dataDir]
  const env = {
    ...process.env,
    HOME: root,
    TOURI_SECRETS_KEY: "synthetic-compiled-fixture",
    TOURI_VM_INTEGRATION: "0",
    TOURI_DOCTOR_SKIP_PROVIDER_PROBES: "1",
  }
  const server = Bun.spawn([binary, "serve", ...args, "--port", String(getFixturePort())], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = new Response(server.stdout).text()
  const errors = new Response(server.stderr).text()
  cleanups.add(async () => {
    server.kill("SIGTERM")
    const deadline = setTimeout(() => server.kill("SIGKILL"), 10_000)
    const code = await server.exited
    clearTimeout(deadline)
    const stderr = await errors
    await output
    expect(stderr).not.toContain("module init failed")
    if (process.platform !== "win32") expect(code).toBe(0)
  })
  const info = await getServeInfo(join(dataDir, "run", "serve.json"), server)
  const origin = `http://127.0.0.1:${info.port}`
  const created = await getCommandOutput([binary, "pair", ...args], root, env)
  const code = created.output.match(/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/)?.[0]
  expect(created.code).toBe(0)
  expect(code).toBeDefined()

  const pairing = await fetch(`${origin}/pair`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ code, name: "Synthetic compiled device", client: true }),
    signal: AbortSignal.timeout(5000),
  })
  const paired = (await pairing.json()) as { deviceId: string; token: string }
  expect(pairing.status).toBe(200)
  const getDevices = () =>
    fetch(`${origin}/api/v1/devices`, {
      headers: { Authorization: `Bearer ${paired.token}`, "X-Touri-Client": "compiled-fixture" },
      signal: AbortSignal.timeout(5000),
    })
  expect((await getDevices()).status).toBe(200)
  const revoked = await getCommandOutput([binary, "devices", "revoke", paired.deviceId, ...args], root, env)

  expect(revoked.code).toBe(0)
  expect((await getDevices()).status).toBe(401)
  expect((await getCommandOutput([binary, "devices", ...args], root, env)).output).toContain("No paired devices")
}, 120_000)

const getCommandOutput = async (cmd: string[], cwd: string, env = process.env) => {
  const child = Bun.spawn({ cmd, cwd, env, stdout: "pipe", stderr: "pipe", timeout: 60_000, killSignal: "SIGKILL" })
  const [code, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`Compiled fixture command failed (${code}): ${errors}`)
  return { code, output }
}

const getServeInfo = async (path: string, server: ReturnType<typeof Bun.spawn>) => {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && server.exitCode === null) {
    const info = await readFile(path, "utf8").catch(() => "")
    if (info) return JSON.parse(info) as { port: number }
    await Bun.sleep(50)
  }
  throw new Error("Compiled server did not become ready")
}

const getFixturePort = (): number => {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reservation.port
  reservation.stop(true)
  if (!port) throw new Error("Synthetic server port missing")
  return port
}
