import { afterEach, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAppleContainerProvider } from "../../src/vm"
import { BOT_IMAGE } from "../../src/vm/image"
import { appleContainerAvailable } from "./integration-available"

const containerBinary = Bun.which("container")
const createdIds: Array<string> = []

afterEach(async () => {
  if (containerBinary === null) return
  const provider = createAppleContainerProvider({ binary: containerBinary })
  for (const id of createdIds.splice(0)) await provider.destroy({ id })
})

test.skipIf(!appleContainerAvailable)(
  "Apple Container creates a disposable VM, runs Node, forwards a port, and destroys it (requires service)",
  async () => {
    const provider = createAppleContainerProvider({ binary: containerBinary ?? "container" })
    const id = `touri-vm-test-${process.pid}-${Date.now()}`
    const reservation = Bun.serve({ port: 0, fetch: () => new Response() })
    const hostPort = reservation.port
    if (hostPort === undefined) throw new Error("Bun did not allocate a test port")
    reservation.stop(true)
    createdIds.push(id)

    const createStartedAt = performance.now()
    const create = await provider.create({
      name: id,
      image: process.env.TOURI_VM_TEST_IMAGE ?? BOT_IMAGE,
      cpus: 1,
      memoryMb: 512,
    })
    const createMs = performance.now() - createStartedAt
    expect(create.success).toBe(true)
    if (!create.success) return

    const startStartedAt = performance.now()
    const started = await provider.start({ id })
    const startMs = performance.now() - startStartedAt
    expect(started.success).toBe(true)
    const runningStatus = await provider.status({ id })
    expect(runningStatus).toEqual({ success: true, id, status: "running" })

    const execStartedAt = performance.now()
    const node = await provider.exec({ id, command: "node", args: ["-v"] })
    const execMs = performance.now() - execStartedAt
    expect(node.success).toBe(true)
    if (!node.success) return
    expect(node.stdout.trim()).toMatch(/^v22\./)

    const forwardStartedAt = performance.now()
    const forwarded = await provider.forwardPort({ id, guestPort: 3000, hostPort })
    const forwardMs = performance.now() - forwardStartedAt
    expect(forwarded).toMatchObject({
      success: true,
      guestPort: 3000,
      hostPort,
      hostIp: "127.0.0.1",
      protocol: "tcp",
    })

    const server = await provider.exec({
      id,
      command: "node",
      args: ["-e", "require('node:http').createServer((_,res)=>res.end('touri-vm')).listen(3000,'0.0.0.0')"],
      detach: true,
    })
    expect(server.success).toBe(true)

    let response: Response | null = null
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        if (!forwarded.success) throw new Error("Forward failed")
        response = await fetch(`${forwarded.url}/`)
        break
      } catch {
        await Bun.sleep(100)
      }
    }
    expect(response).not.toBeNull()
    expect(await response?.text()).toBe("touri-vm")

    const destroyStartedAt = performance.now()
    const destroyed = await provider.destroy({ id })
    const destroyMs = performance.now() - destroyStartedAt
    expect(destroyed).toEqual({ success: true, id })
    const status = await provider.status({ id })
    expect(status).toEqual({ success: true, id, status: "missing" })
    console.info(
      `[vm integration] image=${process.env.TOURI_VM_TEST_IMAGE ?? BOT_IMAGE} create=${createMs.toFixed(0)}ms start=${startMs.toFixed(0)}ms exec=${execMs.toFixed(0)}ms forward=${forwardMs}ms destroy=${destroyMs.toFixed(0)}ms hostPort=${hostPort}`,
    )
    createdIds.splice(createdIds.indexOf(id), 1)
  },
  180_000,
)

test("Apple Container provider reports a clear missing-tool result", async () => {
  const provider = createAppleContainerProvider({
    binary: "/definitely/missing/container",
    runCommand: async () => ({ code: 127, stdout: "", stderr: "spawn ENOENT" }),
  })
  const result = await provider.start({ id: "missing" })
  expect(result).toMatchObject({ success: false, errorCode: "TOOL_MISSING" })
})

test.each([
  "Error: internalError: failed to list containers / XPC connection error: Connection invalid / Ensure container system service has been started with container system start.",
  "XPC timeout",
  "failed to list containers",
])("container list service failures have a machine code: %s", async (stderr) => {
  const provider = createAppleContainerProvider({ runCommand: async () => ({ code: 1, stdout: "", stderr }) })
  expect(await provider.status({ id: "bot" })).toMatchObject({
    success: false,
    errorCode: "MACHINE_SERVICE_UNAVAILABLE",
  })
})

test("XPC failures in start and image inspect stay in the machine domain", async () => {
  const provider = createAppleContainerProvider({
    runCommand: async () => ({ code: 1, stdout: "", stderr: "XPC connection error: Connection invalid" }),
  })
  expect(await provider.start({ id: "bot" })).toMatchObject({ errorCode: "MACHINE_SERVICE_UNAVAILABLE" })
  await expect(
    provider.ensureImage({
      progress: () => {
        throw new Error("must not build")
      },
    }),
  ).rejects.toMatchObject({
    errorCode: "machine_service_unavailable",
  })
})

test("starting the service coalesces requests, verifies status and is idempotent", async () => {
  const calls: string[][] = []
  let active = false
  const provider = createAppleContainerProvider({
    runCommand: async (args) => {
      calls.push(args)
      if (args.join(" ") === "system start") {
        active = true
        return { code: 0, stdout: "", stderr: "" }
      }
      return { code: active ? 0 : 1, stdout: active ? "running" : "", stderr: active ? "" : "service not running" }
    },
  })
  const results = await Promise.all([provider.startService(), provider.startService()])
  expect(results.every((result) => result.success)).toBe(true)
  expect(calls.filter((args) => args.join(" ") === "system start")).toHaveLength(1)
  expect(await provider.startService()).toMatchObject({ success: true })
  expect(calls.filter((args) => args.join(" ") === "system start")).toHaveLength(1)
  expect(calls.every((args) => args[0] === "system")).toBe(true)
})

test("service start succeeds when another process starts it between status and start", async () => {
  let active = false
  const provider = createAppleContainerProvider({
    runCommand: async (args) => {
      if (args[1] === "start") {
        active = true
        return { code: 1, stdout: "", stderr: "service already running" }
      }
      return { code: active ? 0 : 1, stdout: "", stderr: "service not running" }
    },
  })
  expect(await provider.startService()).toMatchObject({ success: true })
})

test.each(["start", "status"])("a failed service %s remains actionable and can be retried", async (failure) => {
  let broken = true
  let started = false
  const provider = createAppleContainerProvider({
    runCommand: async (args) => {
      if (args[1] === "start") started = true
      const fails = broken && (args[1] === failure || args[1] === "status")
      return { code: fails || !started ? 1 : 0, stdout: "", stderr: "private diagnostic" }
    },
  })
  expect(await provider.startService()).toMatchObject({ success: false, errorCode: "MACHINE_SERVICE_START_FAILED" })
  broken = false
  expect(await provider.startService()).toMatchObject({ success: true })
})

test("a fake container executable exercises the actual service-start argv without touching the host service", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-container-service-"))
  const binary = join(root, "container")
  const script = join(root, "container.ts")
  writeFileSync(
    binary,
    `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' "$@"\n`,
    { mode: 0o700 },
  )
  writeFileSync(
    script,
    `
import { appendFileSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const args = process.argv.slice(2)
const active = join(import.meta.dir, "active")
appendFileSync(join(import.meta.dir, "calls"), JSON.stringify(args) + "\\n")
if (args.join(" ") === "system start") { writeFileSync(active, "1"); process.exit(0) }
if (args.join(" ") === "system status" && existsSync(active)) process.exit(0)
process.stderr.write("XPC connection error: Connection invalid")
process.exit(1)
`,
  )
  try {
    const provider = createAppleContainerProvider({ binary })
    expect(await provider.status({ id: "own-test-bot" })).toMatchObject({ errorCode: "MACHINE_SERVICE_UNAVAILABLE" })
    expect(await provider.startService()).toMatchObject({ success: true })
    expect(await provider.startService()).toMatchObject({ success: true })
    const calls = readFileSync(join(root, "calls"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(calls).toEqual([
      ["list", "--all", "--format", "json"],
      ["system", "status"],
      ["system", "start"],
      ["system", "status"],
      ["system", "status"],
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("inspect reads the image and reattachable named volumes and bind mounts", async () => {
  const calls: string[][] = []
  const provider = createAppleContainerProvider({
    runCommand: async (args) => {
      calls.push(args)
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify([
          {
            id: "bot",
            configuration: {
              image: { reference: "touri-bot:1" },
              dns: { nameservers: ["1.1.1.1"], options: [], searchDomains: [] },
              mounts: [
                { source: "/volumes/data/volume.img", destination: "/workspace", type: { volume: { name: "data" } } },
                { source: "/host/auth", destination: "/run/touri-auth", type: { virtiofs: {} }, options: ["ro"] },
              ],
            },
          },
        ]),
      }
    },
  })
  expect(await provider.inspect({ id: "bot" })).toEqual({
    success: true,
    image: "touri-bot:1",
    volumes: [
      { type: "volume", source: "data", target: "/workspace", readOnly: false },
      { type: "bind", source: "/host/auth", target: "/run/touri-auth", readOnly: true },
    ],
    dns: ["1.1.1.1"],
  })
  expect(calls).toEqual([["inspect", "bot"]])
})

test.each([
  "invalid json",
  JSON.stringify([{ id: "bot", configuration: { image: { reference: "touri-bot:1" } } }]),
  JSON.stringify([
    {
      id: "bot",
      configuration: {
        image: { reference: "touri-bot:1" },
        mounts: [{ source: "/volumes/data/volume.img", destination: "/workspace", type: { volume: {} } }],
      },
    },
  ]),
])("inspect refuses incomplete or invalid JSON without guessing storage: %s", async (stdout) => {
  const provider = createAppleContainerProvider({ runCommand: async () => ({ code: 0, stdout, stderr: "" }) })
  expect(await provider.inspect({ id: "bot" })).toMatchObject({ success: false, errorCode: "STATUS_FAILED" })
})

test("create/start return the same provider-owned connection ports and derived key identity", async () => {
  const provider = createAppleContainerProvider({ runCommand: async () => ({ code: 0, stdout: "", stderr: "" }) })
  const id = `descriptor-test-${process.pid}-${Date.now()}`
  try {
    const created = await provider.create({ name: id, image: "test-image" })
    expect(created.success).toBe(true)
    if (!created.success) throw new Error(created.error)
    expect(created.connection.authKeyId).toBeNull()
    expect(created.connection).not.toHaveProperty("success")
    expect(created.connection.ports).toHaveLength(2)
    expect(created.connection.endpoints.bridge).toMatch(/^unix:/)
    const keyed = await provider.connection({ id, authKeyId: "derived-id" })
    const started = await provider.start({ id })
    if (!started.success || !keyed.success) throw new Error("Connection failed")
    expect(started.connection).toMatchObject({ machineId: id, provider: "apple-container", authKeyId: "derived-id" })
    expect(started.connection.ports).toEqual(created.connection.ports)
    expect(started.connection.display).toEqual({ name: ":99", width: 1440, height: 900 })
    const preview = await provider.forwardPort({ id, guestPort: 3000 })
    const updated = await provider.connection({ id })
    if (!updated.success || !preview.success) throw new Error("Forward failed")
    expect(updated.ports.find((port) => port.guestPort === 3000)?.url).toBe(preview.url)
  } finally {
    await provider.destroy({ id })
  }
})

test.each([0, 1])("image build exit %s stops its builder using a fake executable", async (exitCode) => {
  const root = mkdtempSync(join(tmpdir(), "touri-build-fake-"))
  const binary = join(root, "fake-container")
  const calls: string[][] = []
  writeFileSync(binary, `#!/bin/sh\nexit ${exitCode}\n`, { mode: 0o700 })
  const provider = createAppleContainerProvider({
    binary,
    dataDir: root,
    availableDiskBytes: () => 20 * 1024 ** 3,
    runCommand: async (args) => {
      calls.push(args)
      return { code: args[0] === "image" ? 1 : 0, stdout: "", stderr: "" }
    },
  })
  try {
    const build = provider.ensureImage({ progress: () => {} })
    if (exitCode) await expect(build).rejects.toThrow("Falha ao construir")
    else await build
    expect(calls).toContainEqual(["builder", "stop"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.each(["abort", "progress", "spawn"])("image build %s still stops the builder", async (failure) => {
  const root = mkdtempSync(join(tmpdir(), "touri-build-fake-"))
  const binary = join(root, "fake-container")
  if (failure !== "spawn") writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 })
  const calls: string[][] = []
  const provider = createAppleContainerProvider({
    binary,
    availableDiskBytes: () => 20 * 1024 ** 3,
    runCommand: async (args) => {
      calls.push(args)
      return { code: args[0] === "image" ? 1 : 0, stdout: "", stderr: "" }
    },
  })
  const controller = new AbortController()
  if (failure === "abort") controller.abort(new Error("cancelled build"))
  try {
    await expect(
      provider.ensureImage({
        signal: controller.signal,
        progress: () => {
          if (failure === "progress") throw new Error("progress failed")
        },
      }),
    ).rejects.toThrow()
    expect(calls).toContainEqual(["builder", "stop"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.each(["create", "start", "cp", "chown", "success", "abort"])(
  "migration finally stops and force deletes its helper after %s without destroying the source",
  async (outcome) => {
    const root = mkdtempSync(join(tmpdir(), "touri-migration-fake-"))
    const source = join(root, "source")
    mkdirSync(join(source, "workspace"), { recursive: true })
    mkdirSync(join(source, "home/node"), { recursive: true })
    writeFileSync(join(source, "workspace/data"), "preserved")
    const archive = join(root, "source.tar")
    expect(await Bun.spawn(["/usr/bin/tar", "-cf", archive, "-C", source, "workspace", "home/node"]).exited).toBe(0)
    const calls: string[][] = []
    const controller = new AbortController()
    const provider = createAppleContainerProvider({
      runCommand: async (args, options) => {
        calls.push(args)
        if (args[0] === "export") cpSync(archive, args[2] ?? "")
        if (args[0] === "volume" && args[1] === "inspect") return { code: 1, stdout: "", stderr: "not found" }
        if (args[0] === "exec" && outcome === "abort") {
          controller.abort(new Error("migration canceled"))
          options?.signal?.throwIfAborted()
        }
        const failed = args[0] === outcome || (args[0] === "exec" && args[2] === outcome)
        return { code: failed ? 1 : 0, stdout: "", stderr: failed ? "migration step failed" : "" }
      },
    })
    try {
      const migration = provider.migrateWorkspace({
        id: "original-bot",
        path: join(root, "backup"),
        signal: controller.signal,
      })
      if (outcome === "abort") await expect(migration).rejects.toThrow("migration canceled")
      else expect((await migration).success).toBe(outcome === "success")
      const helper = calls.find((args) => args[0] === "create")?.[2]
      if (!helper) throw new Error("Missing helper create")
      expect(helper).toMatch(/^touri-migrate-/)
      expect(calls.slice(-2)).toEqual([
        ["stop", "--time", "5", helper],
        ["delete", "--force", helper],
      ])
      expect(calls).not.toContainEqual(["delete", "--force", "original-bot"])
      expect(readFileSync(join(root, "backup/workspace/data"), "utf8")).toBe("preserved")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test("host folders use realpath bind mounts and Apple's readonly option (no real VM)", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-mount-args-"))
  const calls: string[][] = []
  const provider = createAppleContainerProvider({
    binary: "/fake/container",
    runCommand: async (args) => {
      calls.push(args)
      return { code: 0, stdout: "", stderr: "" }
    },
  })
  try {
    const result = await provider.create({
      name: "folder-args-test",
      image: "fake",
      volumes: [
        { type: "bind", source: root, target: "/host/reference", readOnly: true },
        { type: "volume", source: "workspace", target: "/workspace" },
      ],
    })
    expect(result.success).toBe(true)
    const create = calls.find((args) => args[0] === "create") ?? []
    expect(create).toContain(`type=bind,source=${realpathSync(root)},target=/host/reference,readonly`)
    expect(create).toContain("type=volume,source=workspace,target=/workspace")
    expect(
      await provider.create({
        name: "bad",
        image: "fake",
        volumes: [{ source: `${root},readonly`, target: "/host/bad" }],
      }),
    ).toMatchObject({ success: false, errorCode: "INVALID_CONFIG" })
  } finally {
    await provider.destroy({ id: "folder-args-test" })
    rmSync(root, { recursive: true, force: true })
  }
})

test("managed host mounts reject symlinks and retargeted ancestors before calling container", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touri-mount-retarget-")))
  const source = join(root, "selected")
  const outside = join(root, "outside")
  mkdirSync(source)
  mkdirSync(outside)
  const calls: string[][] = []
  const provider = createAppleContainerProvider({
    binary: "/fake/container",
    runCommand: async (args) => {
      calls.push(args)
      return { code: 0, stdout: "", stderr: "" }
    },
  })
  try {
    rmSync(source, { recursive: true })
    symlinkSync(outside, source)
    expect(
      await provider.create({ name: "retarget", image: "fake", volumes: [{ source, target: "/host/selected" }] }),
    ).toMatchObject({ success: false, errorCode: "INVALID_CONFIG" })
    mkdirSync(join(outside, "nested"))
    expect(
      await provider.create({
        name: "ancestor",
        image: "fake",
        volumes: [{ source: join(source, "nested"), target: "/host/nested" }],
      }),
    ).toMatchObject({ success: false, errorCode: "INVALID_CONFIG" })
    expect(calls).toHaveLength(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
