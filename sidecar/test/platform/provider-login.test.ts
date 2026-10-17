import { expect, test } from "bun:test"
import type { Kernel } from "@touri/contracts"
import { spawnProviderLoginPty } from "../../src/platform/provider-login"

test("login sessions use the PTY spawn interface and strip desktop capabilities", () => {
  let received: Parameters<Kernel["spawnTree"]>[0] | undefined
  const spawn: Kernel["spawnTree"] = (input) => {
    received = input
    return { success: false, errorCode: "SPAWN_FAILED", error: "inert fixture" }
  }
  const helper = "C:\\Program Files\\touri\\touri.exe"
  expect(
    spawnProviderLoginPty({
      command: "codex.exe",
      args: ["login", "--device-auth"],
      cwd: "C:\\fixture",
      platform: "win32",
      spawn,
      env: {
        TOURI_DESKTOP_HELPER: helper,
        TOURI_UI_TOKEN: "inert-ui",
        TOURI_HOST_TOKEN: "inert-host",
        PATH: "fixture-path",
      },
    }),
  ).toMatchObject({ errorCode: "SPAWN_FAILED" })
  expect(received).toEqual({
    cmd: helper,
    args: ["--provider-login-pty", "--", "codex.exe", "login", "--device-auth"],
    cwd: "C:\\fixture",
    env: { TOURI_DESKTOP_HELPER: helper, PATH: "fixture-path" },
  })
  received = undefined
  const previous = process.env.TOURI_DESKTOP_HELPER
  process.env.TOURI_DESKTOP_HELPER = helper
  try {
    expect(
      spawnProviderLoginPty({
        command: "provider.exe",
        args: [],
        cwd: "C:\\fixture",
        platform: "win32",
        spawn,
        env: {},
      }),
    ).toMatchObject({ success: false, errorCode: "SPAWN_FAILED" })
    expect(received).toBeUndefined()
  } finally {
    if (previous === undefined) delete process.env.TOURI_DESKTOP_HELPER
    else process.env.TOURI_DESKTOP_HELPER = previous
  }
})

test("PTY adapters preserve provider arguments and require the installed Windows helper", async () => {
  const { providerLoginPty } = await import("../../src/platform/provider-login")
  const linux = providerLoginPty("linux", "example-provider", ["login", "literal;argument"])
  expect(linux).toMatchObject({ supported: true, command: "script" })
  if (linux.supported) expect(linux.args).toContain("'example-provider' 'login' 'literal;argument'")
  expect(providerLoginPty("darwin", "example-provider", ["login"])).toMatchObject({
    supported: true,
    command: "/usr/bin/expect",
  })
  expect(providerLoginPty("win32", "example-provider", [], "")).toMatchObject({
    supported: false,
    message: expect.stringContaining("ConPTY"),
  })
  const helper = "C:\\Program Files\\touri\\touri.exe"
  for (const [command, args] of [
    ["claude.exe", ["setup-token"]],
    ["codex.exe", ["login", "--device-auth"]],
    ["opencode.exe", ["auth", "login", "literal & argument"]],
  ] as const) {
    expect(providerLoginPty("win32", command, [...args], helper)).toEqual({
      supported: true,
      command: helper,
      args: ["--provider-login-pty", "--", command, ...args],
    })
  }
  expect(providerLoginPty("win32", "provider.exe", [], "relative.exe").supported).toBe(false)
})

test("macOS PTY forwards literal argv through expect's environment with main's terminal settings", () => {
  let received: Parameters<Kernel["spawnTree"]>[0] | undefined
  const args = ["setup-token", "literal ' $value; [command]"]
  spawnProviderLoginPty({
    command: "/Applications/CLI tools/claude",
    args,
    cwd: "/tmp",
    platform: "darwin",
    env: { PATH: "/usr/bin:/bin", TOURI_HOST_TOKEN: "inert-token" },
    spawn: (input) => {
      received = input
      return { success: false, errorCode: "SPAWN_FAILED", error: "inert fixture" }
    },
  })
  expect(received?.cmd).toBe("/usr/bin/expect")
  expect(received?.args[1]).toContain('set stty_init "columns 240 rows 40"')
  expect(received?.env.TOURI_LOGIN_ARGV?.split("\x1f")).toEqual(["/Applications/CLI tools/claude", ...args])
  expect(received?.env.TOURI_HOST_TOKEN).toBeUndefined()
})
