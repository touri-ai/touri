import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createOciProvider } from "../../src/platform/oci-provider"
import type { VmCommandOutput } from "../../src/vm/command"

const ok = (stdout = ""): VmCommandOutput => ({ code: 0, stdout, stderr: "" })
const fixture = () => {
  const calls: string[][] = []
  const provider = createOciProvider({
    engine: "podman",
    platform: "linux",
    run: async (args) => {
      calls.push(args)
      return ok()
    },
  })
  return { calls, provider }
}
test.each(["podman", "docker"] as const)(
  "%s preserves host folder grants and rejects retargeted grants",
  async (engine) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "touri-oci-folders-")))
    const source = join(root, "selected")
    const outside = join(root, "outside")
    mkdirSync(source)
    mkdirSync(outside)
    const calls: string[][] = []
    const provider = createOciProvider({
      engine,
      run: async (args) => {
        calls.push(args)
        return ok()
      },
    })
    const options = {
      name: "touri-folders",
      image: "touri-bot:8",
      volumes: [
        { type: "volume" as const, source: "touri-workspace", target: "/workspace" },
        { type: "bind" as const, source, target: "/host/selected", readOnly: true },
      ],
    }
    try {
      expect((await provider.create(options)).success).toBe(true)
      expect(calls[0]).toContain(`type=bind,source=${source},target=/host/selected,readonly`)
      expect(calls[0]).toContain("type=volume,source=touri-workspace,target=/workspace")
      rmSync(source, { recursive: true })
      symlinkSync(outside, source, process.platform === "win32" ? "junction" : "dir")
      const before = calls.length
      expect(await provider.create(options)).toMatchObject({ success: false, errorCode: "INVALID_CONFIG" })
      expect(calls).toHaveLength(before)
    } finally {
      await provider.destroy({ id: options.name })
      rmSync(root, { recursive: true, force: true })
    }
  },
)
test("OCI bot lifecycle uses guest policy, private channels and persistent volumes", async () => {
  const { calls, provider } = fixture()
  try {
    const created = await provider.create({
      name: "touri-test",
      image: "touri-bot:8",
      entrypoint: "/usr/local/lib/touri/init.sh",
      memoryMb: 2048,
      volumes: [
        { type: "volume", source: "touri-workspace", target: "/workspace" },
        { type: "volume", source: "touri-browser", target: "/var/lib/touri-browser" },
      ],
      dns: ["1.1.1.1"],
    })
    expect(created.success).toBe(true)
    const args = calls[0] ?? []
    expect(args).toContain("NET_ADMIN")
    expect(args).toContain("no-new-privileges")
    expect(args).toContain("slirp4netns:allow_host_loopback=false")
    expect(args).toContain("type=volume,source=touri-workspace,target=/workspace")
    expect(args).toContain("2048M")
    expect(args).not.toContain("--publish")
    expect(args).not.toContain("--privileged")
    if (created.success) expect(created.connection.provider).toBe("podman")
    expect((await provider.start({ id: "touri-test" })).success).toBe(true)
  } finally {
    await provider.destroy({ id: "touri-test" })
  }
  expect(calls.at(-1)).toEqual(["rm", "--force", "touri-test"])
})
test("reject unsafe names, mount syntax and published ports before running commands", async () => {
  const { calls, provider } = fixture()
  for (const patch of [
    { name: "--host" },
    { ports: [{ guestPort: 5900, hostPort: 5900 }] },
    { volumes: [{ source: "/data,readonly", target: "/workspace" }] },
    { memoryMb: 0 },
  ])
    expect((await provider.create({ name: "touri-test", image: "touri-bot:8", ...patch })).success).toBe(false)
  expect(calls).toEqual([])
})
test("engine failure explains local fallback without attempting privileged startup", async () => {
  const calls: string[][] = []
  const provider = createOciProvider({
    engine: "podman",
    platform: "linux",
    run: async (args) => {
      calls.push(args)
      return { code: 125, stdout: "", stderr: "namespace unavailable" }
    },
  })
  const result = await provider.startService()
  expect(result.success).toBe(false)
  if (!result.success) expect(result.error).toContain("local bots")
  expect((await provider.doctor())[0]?.detail).toContain("Local bots")
  expect(calls.every((c) => c[0] === "info")).toBe(true)
})
test("parse Docker/Podman inspect and retain mounted workspace during upgrades", async () => {
  const provider = createOciProvider({
    engine: "docker",
    run: async () =>
      ok(
        JSON.stringify([
          {
            Config: { Image: "touri-bot:8" },
            HostConfig: { Memory: 2147483648, Dns: ["1.1.1.1"] },
            Mounts: [
              {
                Type: "volume",
                Name: "touri-data",
                Source: "/var/lib/volumes/data",
                Destination: "/workspace",
                RW: true,
              },
            ],
          },
        ]),
      ),
  })
  const inspection = await provider.inspect({ id: "touri-test" })
  expect(inspection).toMatchObject({
    success: true,
    memoryMb: 2048,
    volumes: [{ type: "volume", source: "touri-data", target: "/workspace", readOnly: false }],
  })
  expect(await provider.migrateWorkspace({ id: "touri-test", path: "/unused" })).toEqual({
    success: true,
    type: "volume",
    source: "touri-data",
    target: "/workspace",
    readOnly: false,
  })
})
