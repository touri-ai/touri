import { expect, test } from "bun:test"
import { probeOciService } from "../../src/platform/oci-health"
import { createOciProvider } from "../../src/platform/oci-provider"
import type { VmCommandOutput } from "../../src/vm/command"
import { privateSocket } from "../../src/vm/local-transport"

const ok = (value: unknown): VmCommandOutput => ({ code: 0, stdout: JSON.stringify(value), stderr: "" })
const desktop = { OSType: "linux", OperatingSystem: "Docker Desktop", KernelVersion: "fixture-microsoft-standard-WSL2" }
const pipe = "npipe:////./pipe/dockerDesktopLinuxEngine"

test.each([
  { info: { ...desktop, OSType: "windows" }, context: pipe },
  { info: { ...desktop, KernelVersion: "linuxkit" }, context: pipe },
  { info: { ...desktop, OperatingSystem: "Other Linux" }, context: pipe },
  { info: desktop, context: "ssh://example.test" },
  { info: desktop, context: "tcp://example.test:2376" },
  { info: desktop, context: pipe, dockerHost: "tcp://example.test:2376" },
  { info: "invalid info", context: pipe },
])("Windows rejects an incompatible engine or remote context: %j", async ({ info, context, dockerHost }) => {
  const result = await probeOciService({
    engine: "docker",
    platform: "win32",
    dockerHost: dockerHost ?? "",
    run: async (args) => ok(args[0] === "info" ? info : context),
  })
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain("WSL2")
  expect(result.stderr).toContain("Local bots")
})

test("Windows Docker Desktop reuses OCI lifecycle, persistent mounts and private exec channels", async () => {
  const calls: string[][] = []
  const provider = createOciProvider({
    engine: "docker",
    platform: "win32",
    run: async (args) => {
      calls.push(args)
      return args[0] === "info" ? ok(desktop) : args[0] === "context" ? ok(pipe) : ok([])
    },
  })
  try {
    expect(await provider.startService()).toEqual({ success: true })
    expect((await provider.doctor())[0]?.ok).toBe(true)
    expect(
      (
        await provider.create({
          name: "touri-fixture",
          image: "touri-bot:8",
          entrypoint: "/usr/local/lib/touri/init.sh",
          volumes: [
            { type: "volume", source: "fixture-workspace", target: "/workspace" },
            { type: "bind", source: "C:\\fixture workspace", target: "/fixture" },
          ],
        })
      ).success,
    ).toBe(true)
    const create = calls.find((args) => args[0] === "create") ?? []
    expect(create).toContain("bridge")
    expect(create).toContain("NET_ADMIN")
    expect(create).toContain("type=volume,source=fixture-workspace,target=/workspace")
    expect(create).toContain("type=bind,source=C:\\fixture workspace,target=/fixture")
    expect(create).not.toContain("--privileged")
    expect(create).not.toContain("--publish")
    expect((await provider.stop({ id: "touri-fixture" })).success).toBe(true)
  } finally {
    await provider.destroy({ id: "touri-fixture" })
  }
})

test("unavailable Desktop is diagnosed without launching a daemon and preserves local fallback", async () => {
  const calls: string[][] = []
  const provider = createOciProvider({
    engine: "docker",
    platform: "win32",
    run: async (args) => {
      calls.push(args)
      return { code: 127, stdout: "", stderr: "fixture unavailable" }
    },
  })
  expect(await provider.startService()).toMatchObject({
    success: false,
    errorCode: "MACHINE_SERVICE_UNAVAILABLE",
    error: expect.stringContaining("Local bots"),
  })
  expect((await provider.doctor())[0]).toMatchObject({ ok: false, fix: expect.stringContaining("WSL2") })
  expect(calls.every((args) => args[0] === "info")).toBe(true)
  expect(
    (await probeOciService({ engine: "podman", platform: "linux", run: async () => ok("legacy info output") })).code,
  ).toBe(0)
})

test("Windows private control pipes have unpredictable names and no filesystem socket path", async () => {
  const first = await privateSocket("win32")
  const second = await privateSocket("win32")
  try {
    expect(first.path).toMatch(/^\\\\\.\\pipe\\touri-channel-[a-f0-9]{64}$/)
    expect(first.path).not.toBe(second.path)
  } finally {
    await first.remove()
    await second.remove()
  }
})
