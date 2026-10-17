import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DoctorCheck, Kernel } from "@touri/contracts"
import { botSessionPath, saveBotSession } from "../../src/browser/sessionVault"
import { type CommandResult, createDoctorCommand, type DoctorCommand } from "../../src/doctor/command"
import {
  collectLocalChecks,
  diskCheck,
  keychainCheck,
  type LocalProbes,
  localProbes,
  sidecarChecks,
} from "../../src/doctor/local"
import { createKernel } from "../../src/kernel"
import { SCHEMA_VERSION } from "../../src/kernel/db"
import { createAppPaths } from "../../src/kernel/paths"
import { BOT_IMAGE } from "../../src/vm/image"
import { providerLoginSourceKey } from "../../src/vm/provider-login"

const signal = (): AbortSignal => new AbortController().signal
const output = (stdout = "", code = 0, stderr = "", timedOut = false): CommandResult => ({
  code,
  stdout,
  stderr,
  timedOut,
})
const probes: LocalProbes = {
  ...localProbes,
  platform: "darwin",
  arch: "arm64",
  osRelease: "25.0.0",
  headless: false,
  which: (name, path) => {
    expect(path).toBe("/login/shell/bin")
    return `/diagnostic-fake/${name}`
  },
  freeBytes: () => 20 * 1024 ** 3,
  kernelPresent: () => true,
  memory: () => ({ total: 8 * 1024 ** 3, free: 4 * 1024 ** 3 }),
}
const command: DoctorCommand = async (binary, args) => {
  if (args.includes("--version"))
    return output(binary.endsWith("container") ? "container CLI version 1.5.0" : "2.3.4 secret-version-output")
  if (args[0] === "auth") return output(JSON.stringify({ loggedIn: true, email: "secret-email-output" }))
  if (args.includes("login")) return output("", 0, "secret-auth-output")
  if (args[0] === "system") return output("secret-container-status-output")
  if (args[0] === "image") return output("secret-image-output")
  if (args[0] === "list") return output("[]")
  return output()
}
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "touri-doctor-"))
  const runtime = createKernel({ appData: root })
  const hostCalls: Array<unknown> = []
  const kernel: Kernel = {
    ...runtime.kernel,
    callHost: (async (method: string, params: unknown) => {
      hostCalls.push({ method, params })
      return { success: true, value: { value: "secret-keychain-output" } }
    }) as Kernel["callHost"],
  }
  return {
    kernel,
    hostCalls,
    close: () => {
      runtime.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
}
const find = (checks: Array<DoctorCheck>, id: string): DoctorCheck => {
  const item = checks.find((candidate) => candidate.id === id)
  if (!item) throw new Error(`missing check ${id}`)
  return item
}

for (const host of [
  { platform: "darwin", headless: false },
  { platform: "linux", headless: true },
  { platform: "linux", headless: false },
  { platform: "darwin", headless: true },
])
  test(`${host.platform} headless=${host.headless}: Doctor offers only recovery available on its host`, async () => {
    const f = fixture()
    try {
      const db = f.kernel.db as import("bun:sqlite").Database
      db.run(
        "INSERT INTO bots (id,name,provider,home_dir,machine,vm_provider_login,created_at,updated_at) VALUES ('saved','Bot de teste','codex',?,'vm',1,1,1)",
        [f.kernel.paths.appData],
      )
      db.run("INSERT INTO settings VALUES (?, '\"vault\"', 1)", [
        providerLoginSourceKey({ id: "saved", provider: "codex" }),
      ])
      const keys = new Map<string, string>()
      const working: Kernel = {
        ...f.kernel,
        callHost: (async (method: string, input: { account: string; value?: string }) => {
          if (method === "keychain.set") keys.set(input.account, input.value ?? "")
          return { success: true, value: { value: keys.get(input.account) ?? null } }
        }) as Kernel["callHost"],
      }
      expect(
        await saveBotSession({
          kernel: working,
          botId: "saved",
          session: { cookies: [{ name: "synthetic" }], storage: {} },
        }),
      ).toBe(true)
      const path = botSessionPath(f.kernel, "saved")
      const ciphertext = readFileSync(path)
      const denied: Kernel = {
        ...f.kernel,
        callHost: async () => ({ success: false, errorCode: "VAULT_TIMEOUT", error: "synthetic failure" }),
      }
      const checks = await collectLocalChecks(
        denied,
        { PATH: "/login/shell/bin", HOME: f.kernel.paths.appData },
        command,
        signal(),
        { ...probes, ...host },
      )
      const login = find(checks, "provider-login:saved")
      const browser = find(checks, "browser-session:saved")
      expect(login.status).toBe("fail")
      if (host.platform === "darwin" && !host.headless) {
        expect(login).toMatchObject({ action: "authorize-vault", vaultAccount: "bot/saved/codex-vm-login" })
        expect(browser).toMatchObject({ action: "authorize-vault", vaultAccount: "browser-session-key:saved" })
      } else {
        expect(login.action).toBeUndefined()
        expect(login.vaultAccount).toBeUndefined()
        expect(login.detail).toContain("cofre local do servidor")
        expect(login.detail).not.toMatch(/macOS|Permita o acesso/)
        expect(login.fix).toBeNull()
        expect(find(checks, "keychain").fix).toBeNull()
        expect(browser.action).toBeUndefined()
        expect(browser.vaultAccount).toBeUndefined()
        expect(browser.detail).toContain("cofre local do servidor")
      }
      expect(readFileSync(path)).toEqual(ciphertext)
      const recovered = await collectLocalChecks(
        working,
        { PATH: "/login/shell/bin", HOME: f.kernel.paths.appData },
        command,
        signal(),
        { ...probes, ...host },
      )
      expect(find(recovered, "browser-session:saved")).toMatchObject({ status: "pass" })
      expect(readFileSync(path)).toEqual(ciphertext)
    } finally {
      f.close()
    }
  })

test("local checks use login-shell PATH, status-only CLI commands, and the native Keychain bridge", async () => {
  const f = fixture()
  const calls: Array<{ binary: string; args: Array<string> }> = []
  try {
    const checks = await collectLocalChecks(
      f.kernel,
      { PATH: "/login/shell/bin" },
      async (binary, args, abort) => {
        calls.push({ binary, args })
        return command(binary, args, abort)
      },
      signal(),
      probes,
    )
    for (const id of [
      "claude",
      "codex",
      "claude-auth",
      "codex-auth",
      "container",
      "vm-system",
      "vm-image",
      "vm-kernel",
      "vm-ram",
      "disk",
      "keychain",
    ])
      expect(find(checks, id)).toMatchObject({ status: "pass", ok: true, fix: null })
    expect(calls).toContainEqual({ binary: "/diagnostic-fake/claude", args: ["auth", "status"] })
    const codexCalls = calls.filter((item) => item.binary.endsWith("codex"))
    expect(codexCalls).toHaveLength(2)
    expect(codexCalls.some((item) => item.args.slice(-2).join(" ") === "login status")).toBe(true)
    for (const item of codexCalls) {
      expect(item.args).toContain("analytics.enabled=false")
      expect(item.args).toContain('otel.exporter="none"')
      expect(item.args).toContain('otel.trace_exporter="none"')
      expect(item.args).toContain('otel.metrics_exporter="none"')
    }
    expect(f.hostCalls).toEqual([{ method: "keychain.get", params: { account: "doctor/access-check" } }])
    expect(JSON.stringify(checks)).not.toContain("secret-")
    expect(
      calls.some((item) => ["start", "stop", "delete", "build"].some((action) => item.args.includes(action))),
    ).toBe(false)
  } finally {
    f.close()
  }
})

test("desktop Doctor includes per-VM caps and helper warnings without changing containers", async () => {
  const f = fixture()
  const calls: string[][] = []
  try {
    const checks = await collectLocalChecks(
      f.kernel,
      { PATH: "/login/shell/bin" },
      async (binary, args, abort) => {
        calls.push(args)
        if (args[0] === "list")
          return output(
            JSON.stringify([
              {
                configuration: { id: "touri-migrate-leaked", resources: { memoryInBytes: 512 * 1024 ** 2 } },
                status: { state: "running" },
              },
            ]),
          )
        return command(binary, args, abort)
      },
      signal(),
      probes,
    )
    expect(find(checks, "vm-memory:touri-migrate-leaked").detail).toContain("512 MiB")
    expect(find(checks, "vm-orphans")).toMatchObject({ status: "warn", ok: false })
    expect(calls).toContainEqual(["list", "--all", "--format", "json"])
    expect(calls.some((args) => args.some((arg) => ["stop", "delete", "build"].includes(arg)))).toBe(false)
  } finally {
    f.close()
  }
})

test("existing VM kernel and memory prerequisites remain actionable without modifying the host", async () => {
  const f = fixture()
  try {
    const checks = await collectLocalChecks(f.kernel, { PATH: "/login/shell/bin" }, command, signal(), {
      ...probes,
      kernelPresent: () => false,
      memory: () => ({ total: 8 * 1024 ** 3, free: 1024 ** 3 }),
    })
    expect(find(checks, "vm-kernel")).toMatchObject({
      status: "warn",
      fix: "container system kernel set --recommended",
    })
    expect(find(checks, "vm-ram")).toMatchObject({ status: "warn", fix: "open -a 'Activity Monitor'" })
  } finally {
    f.close()
  }
})

test("missing CLIs warn and provide installation/login commands without spawning them", async () => {
  const f = fixture()
  try {
    let spawned = false
    const checks = await collectLocalChecks(
      f.kernel,
      {},
      async () => {
        spawned = true
        return output()
      },
      signal(),
      {
        ...probes,
        which: () => null,
      },
    )
    expect(spawned).toBe(false)
    expect(find(checks, "shell-env").status).toBe("fail")
    expect(find(checks, "claude")).toMatchObject({ status: "warn", fix: "brew install --cask claude-code" })
    expect(find(checks, "codex-auth").fix).toContain("codex login")
    expect(find(checks, "vm-system").status).toBe("warn")
  } finally {
    f.close()
  }
})

test("known signed-out CLI status fails; malformed/unsupported/timed-out status warns", async () => {
  const f = fixture()
  try {
    const checks = await collectLocalChecks(
      f.kernel,
      { PATH: "/login/shell/bin" },
      async (binary, args, abort) => {
        if (args[0] === "auth") return output('{"loggedIn":false}', 1)
        if (args.includes("login")) return output("", 1, "Not logged in")
        return command(binary, args, abort)
      },
      signal(),
      probes,
    )
    expect(find(checks, "claude-auth")).toMatchObject({ status: "fail", fix: "claude auth login" })
    expect(find(checks, "codex-auth")).toMatchObject({ status: "fail", fix: "codex login" })
    for (const result of [output("not-json", 2), output('{"loggedIn":true}', 0, "", true)]) {
      const unknown = await collectLocalChecks(
        f.kernel,
        { PATH: "/login/shell/bin" },
        async (binary, args, abort) =>
          args[0] === "auth" || args.includes("login") ? { ...result, code: 2 } : command(binary, args, abort),
        signal(),
        probes,
      )
      expect(find(unknown, "claude-auth").status).toBe("warn")
      expect(find(unknown, "codex-auth").status).toBe("warn")
    }
  } finally {
    f.close()
  }
})

test("container service failure and unavailable image are separate; the doctor never starts a service", async () => {
  const f = fixture()
  try {
    const checks = await collectLocalChecks(
      f.kernel,
      { PATH: "/login/shell/bin" },
      async (binary, args, abort) =>
        args[0] === "system" || args[0] === "image" ? output("", 1, "secret-error") : command(binary, args, abort),
      signal(),
      probes,
    )
    expect(find(checks, "vm-system")).toMatchObject({
      status: "fail",
      fix: "container system start",
      errorCode: "TOURI-E8001",
      action: "start-machine-service",
      detail: expect.stringContaining("O serviço de máquinas do macOS não está ativo."),
    })
    expect(find(checks, "vm-image").status).toBe("warn")
    expect(JSON.stringify(checks)).not.toContain("secret-error")
  } finally {
    f.close()
  }
})

test("a broken CLI does not hide the other CLI, container, disk or Keychain checks", async () => {
  const f = fixture()
  try {
    const checks = await collectLocalChecks(
      f.kernel,
      { PATH: "/login/shell/bin" },
      async (binary, args, abort) => {
        if (binary.endsWith("claude")) throw new Error("private spawn error")
        return command(binary, args, abort)
      },
      signal(),
      probes,
    )
    expect(find(checks, "claude-auth").status).toBe("warn")
    for (const id of ["codex-auth", "vm-system", "disk", "keychain"]) expect(find(checks, id).status).toBe("pass")
    expect(JSON.stringify(checks)).not.toContain("private spawn error")
  } finally {
    f.close()
  }
})

test("Claude status supports documented authentication modes without exposing account data", async () => {
  const f = fixture()
  try {
    for (const [authMethod, code, expected] of [
      ["claude.ai", 0, "pass"],
      ["api_key", 0, "pass"],
      ["none", 1, "fail"],
      ["unknown", 0, "warn"],
      ["claude.ai", 2, "warn"],
    ] as const) {
      const checks = await collectLocalChecks(
        f.kernel,
        { PATH: "/login/shell/bin" },
        async (binary, args, abort) =>
          args[0] === "auth"
            ? output(JSON.stringify({ authMethod, email: "private account" }), code)
            : command(binary, args, abort),
        signal(),
        probes,
      )
      expect(find(checks, "claude-auth").status).toBe(expected)
      expect(JSON.stringify(checks)).not.toContain("private account")
    }
  } finally {
    f.close()
  }
})

test("missing image provides a build command pointing to prepared original sources, safely quoted", async () => {
  const f = fixture()
  try {
    const checks = await collectLocalChecks(
      f.kernel,
      { PATH: "/login/shell/bin" },
      async (binary, args, abort) => (args[0] === "image" ? output("", 1) : command(binary, args, abort)),
      signal(),
      probes,
    )
    const image = find(checks, "vm-image")
    expect(image.status).toBe("warn")
    expect(image.fix).toContain(`container build --tag '${BOT_IMAGE}'`)
    expect(image.fix).toContain(f.kernel.paths.appData)
    expect(
      await Bun.file(join(f.kernel.paths.appData, `vm-image-${BOT_IMAGE.split(":")[1]}`, "Containerfile")).exists(),
    ).toBe(true)
    const badDisk = await collectLocalChecks(
      f.kernel,
      { PATH: "/login/shell/bin" },
      async (binary, args, abort) => (args[0] === "image" ? output("", 1) : command(binary, args, abort)),
      signal(),
      {
        ...probes,
        prepareImage: () => {
          throw new Error("disk full secret")
        },
      },
    )
    expect(find(badDisk, "vm-image").status).toBe("fail")
    expect(find(badDisk, "codex-auth").status).toBe("pass")
  } finally {
    f.close()
  }
})

test("unsupported hosts warn without touching container commands or native Keychain", async () => {
  const f = fixture()
  try {
    for (const host of [{ platform: "linux" }, { arch: "x64" }, { osRelease: "24.0.0" }, { headless: true }]) {
      const calls: Array<string> = []
      const checks = await collectLocalChecks(
        f.kernel,
        { PATH: "/login/shell/bin" },
        async (binary, args, abort) => {
          calls.push(binary)
          return command(binary, args, abort)
        },
        signal(),
        { ...probes, ...host },
      )
      expect(find(checks, "container").status).toBe("warn")
      expect(calls.some((item) => item.endsWith("container"))).toBe(false)
      if (host.platform === "linux" || host.headless) expect(find(checks, "keychain").status).toBe("warn")
    }
  } finally {
    f.close()
  }
})

test("disk pressure uses 5 GiB with a cached image, 12 GiB for a build, and handles failed statfs", () => {
  for (const [gb, image, expected] of [
    [4, true, "fail"],
    [8, true, "pass"],
    [8, false, "warn"],
    [12, false, "pass"],
  ] as const)
    expect(diskCheck("/data", { ...probes, freeBytes: () => gb * 1024 ** 3 }, image).status).toBe(expected)
  const failure = diskCheck(
    "/user's data",
    {
      ...probes,
      freeBytes: () => {
        throw new Error("secret")
      },
    },
    false,
  )
  expect(failure.status).toBe("fail")
  expect(failure.fix).toBe("df -h '/user'\\''s data'")
})

test("schema checks do not migrate or repair a mismatched database", () => {
  const f = fixture()
  try {
    expect(find(sidecarChecks(f.kernel), "sidecar-schema").status).toBe("pass")
    const db = f.kernel.db as import("bun:sqlite").Database
    db.query("UPDATE schema_meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 1))
    expect(find(sidecarChecks(f.kernel), "sidecar-schema").status).toBe("fail")
    expect(db.query("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()).toEqual({
      value: String(SCHEMA_VERSION + 1),
    })
    expect(find(sidecarChecks(f.kernel), "sidecar-version").detail).toContain(Bun.version)
  } finally {
    f.close()
  }
})

test("Keychain bridge failures explain the fix without exposing native errors", async () => {
  const f = fixture()
  try {
    const denied: Kernel = {
      ...f.kernel,
      callHost: async () => ({ success: false, errorCode: "HOST_ERROR", error: "secret native error" }),
    }
    const result = await keychainCheck(denied, signal(), probes)
    expect(result).toMatchObject({ status: "fail", fix: "open -a 'Keychain Access'" })
    expect(result.detail).not.toContain("secret")
  } finally {
    f.close()
  }
})

test("doctor subprocesses drain both pipes, close stdin, bound retained output, and disable CLI telemetry", async () => {
  const f = fixture()
  try {
    const run = createDoctorCommand(f.kernel, {
      PATH: process.env.PATH ?? "",
      TOURI_UI_TOKEN: "private-ui-token",
      TOURI_HOST_TOKEN: "private-host-token",
      MCP_AUTH_TOKEN: "private-mcp-token",
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    })
    const result = await run(
      process.execPath,
      [
        "-e",
        'process.stdin.resume(); process.stdin.on("end", () => { process.stdout.write("a".repeat(100000)); process.stderr.write("b".repeat(100000)) })',
      ],
      signal(),
    )
    expect(result.code).toBe(0)
    expect(result.stdout.length).toBe(16_384)
    expect(result.stderr.length).toBe(16_384)
    const env = await run(
      process.execPath,
      [
        "-e",
        'process.stdout.write(process.env.DISABLE_TELEMETRY + ":" + process.env.DISABLE_ERROR_REPORTING + ":" + process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)',
      ],
      signal(),
    )
    expect(env.stdout).toBe("1:1:1")
    const privateEnvironment = await run(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify(process.env))"],
      signal(),
    )
    expect(privateEnvironment.stdout).not.toContain("private-")
    expect(JSON.parse(privateEnvironment.stdout)).toMatchObject({
      CLAUDE_CODE_ENABLE_TELEMETRY: "0",
      DO_NOT_TRACK: "1",
    })
  } finally {
    f.close()
  }
})

test("command deadlines settle and cancel pipes even if a child never reports exit", async () => {
  let killed = 0
  let canceled = 0
  const pipe = () =>
    new ReadableStream<Uint8Array>({
      cancel: () => {
        canceled += 1
      },
    })
  const kernel: Pick<Kernel, "paths" | "spawnTree"> = {
    paths: createAppPaths({ appData: "/data" }),
    spawnTree: () => ({
      success: true,
      pid: 123,
      pgid: 123,
      stdout: pipe(),
      stderr: pipe(),
      stdin: new WritableStream<Uint8Array>(),
      extra: [],
      exited: new Promise(() => undefined),
      kill: () => {
        killed += 1
      },
    }),
  }
  const result = await createDoctorCommand(kernel, {}, 20)("fake-cli", [], signal())
  expect(result.timedOut).toBe(true)
  expect(killed).toBeGreaterThan(0)
  expect(canceled).toBe(2)
})

test("doctor subprocess deadlines and shutdown terminate only their own child process", async () => {
  const f = fixture()
  try {
    const run = createDoctorCommand(f.kernel, { PATH: process.env.PATH ?? "" }, 100)
    const result = await run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], signal())
    expect(result.timedOut).toBe(true)
    const controller = new AbortController()
    const pending = run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow()
  } finally {
    f.close()
  }
})

test("a failed output stream cancels its sibling instead of leaving a pending read", async () => {
  let canceled = false
  const kernel: Pick<Kernel, "paths" | "spawnTree"> = {
    paths: createAppPaths({ appData: "/data" }),
    spawnTree: () => ({
      success: true,
      pid: 123,
      pgid: 123,
      stdout: new ReadableStream({ start: (controller) => controller.error(new Error("private pipe error")) }),
      stderr: new ReadableStream({
        cancel: () => {
          canceled = true
        },
      }),
      stdin: new WritableStream(),
      extra: [],
      exited: Promise.resolve({ code: 0, signal: null }),
      kill: () => undefined,
    }),
  }
  const result = await createDoctorCommand(kernel, {})("fake-cli", [], signal())
  expect(result).toEqual({ code: null, stdout: "", stderr: "", timedOut: false })
  expect(canceled).toBe(true)
})
