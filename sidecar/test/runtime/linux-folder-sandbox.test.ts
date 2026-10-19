import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Kernel, StartTurnArgs } from "@touri/contracts"
import { folderGrantProblem, refreshHostFolderAccess } from "../../src/kernel/folder-capability"
import { spawnTree } from "../../src/kernel/spawn"
import { codexAccessParams } from "../../src/runtime/codex/config"
import { spawnFolderProvider } from "../../src/runtime/folder-access"
import { linuxFolderEnvironment, linuxFolderSandbox } from "../../src/runtime/linux-folder-sandbox"

// Each case starts several real namespaces; loaded CI hosts need time for I/O.
setDefaultTimeout(30_000)

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})
const available = process.platform === "linux" && (await refreshHostFolderAccess())

const fixture = ({
  approvals = "on-request",
  access = "workspace-write",
  grantFree = false,
  spawn = spawnTree,
}: {
  approvals?: StartTurnArgs["bot"]["approvals"]
  access?: StartTurnArgs["bot"]["access"]
  grantFree?: boolean
  spawn?: Kernel["spawnTree"]
} = {}) => {
  // Outside /tmp: masking temporary files must not accidentally make these pass.
  const root = mkdtempSync(join(homedir(), "touri-linux-folders-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, "home")
  const appData = join(home, "app")
  const runDir = join(appData, "run")
  const workspace = join(appData, "bots/current")
  const ro = join(home, "reference")
  const rw = join(home, "output")
  const providerHome = join(appData, "provider/current")
  for (const path of [
    runDir,
    workspace,
    ro,
    rw,
    providerHome,
    join(home, ".ssh"),
    join(home, "ungranted"),
    join(home, ".codex/sessions"),
    join(appData, "provider/other"),
    join(appData, "bots/other"),
    join(workspace, ".touri-claude"),
    join(runDir, "turn-temp"),
  ])
    mkdirSync(path, { recursive: true })
  writeFileSync(join(ro, "reference.txt"), "reference")
  writeFileSync(join(appData, "credential"), "private")
  writeFileSync(join(appData, "bots/other/memory"), "private")
  writeFileSync(join(home, ".ssh/key"), "private")
  writeFileSync(join(home, "ungranted/marker"), "ungranted-secret")
  writeFileSync(join(home, ".env"), "PRIVATE_TOKEN=ungranted-secret")
  writeFileSync(join(appData, "touri.db"), "private-db")
  writeFileSync(join(home, ".codex/auth.json"), "current-provider-login")
  writeFileSync(join(home, ".codex/sessions/private"), "private-history")
  writeFileSync(join(appData, "provider/other/auth.json"), "other-bot-login")
  symlinkSync(join(home, ".codex/auth.json"), join(providerHome, "auth.json"))
  const kernel = { paths: { appData, runDir }, spawnTree: spawn } as Kernel
  const bot: Partial<StartTurnArgs["bot"]> = {
    provider: "codex",
    machine: "local",
    homeDir: workspace,
    access,
    approvals,
    folders: grantFree
      ? []
      : [
          { path: ro, access: "read-only" },
          { path: rw, access: "read-write" },
        ],
  }
  const args: StartTurnArgs = {
    bot: bot as StartTurnArgs["bot"],
    thread: { id: "current-thread" } as StartTurnArgs["thread"],
    fingerprint: { cwd: workspace } as StartTurnArgs["fingerprint"],
    session: null,
    input: [],
    developerInstructions: "",
    handoffPacket: null,
    mcp: { command: "/bin/true", args: [], env: {} },
    env: { HOME: home, CODEX_HOME: providerHome, TMPDIR: join(runDir, "turn-temp") },
    onEvent: () => {},
    signal: new AbortController().signal,
  }
  const shell = (script: string, ...values: string[]) =>
    Bun.spawnSync({
      cmd: [
        "/usr/bin/bwrap",
        ...linuxFolderSandbox(kernel, args, args.env, home),
        "--",
        "/bin/sh",
        "-c",
        script,
        "test",
        ...values,
      ],
      cwd: workspace,
      env: linuxFolderEnvironment(args, args.env),
      timeout: 10_000,
    })
  return { root, home, appData, workspace, ro, rw, kernel, args, shell }
}

const runProviderShell = async (f: ReturnType<typeof fixture>, script: string, ...values: string[]) => {
  const child = spawnFolderProvider(f.kernel, f.args, {
    cmd: "/bin/sh",
    args: ["-c", script, "test"].concat(values),
    cwd: f.workspace,
    env: f.args.env,
  })
  if (!child.success) throw new Error(child.error)

  const [stdout, stderr, result] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, code: result.code }
}

for (const provider of ["codex", "claude", "opencode"] as const)
  test.skipIf(!available)(`${provider}: ungranted reads cannot escape the minimal filesystem`, () => {
    const f = fixture()
    f.args.bot.provider = provider
    if (provider === "claude") f.args.env.CLAUDE_CONFIG_DIR = f.args.env.CODEX_HOME ?? ""
    if (provider === "opencode") f.args.env.XDG_DATA_HOME = f.args.env.CODEX_HOME ?? ""
    const secret = join(f.home, "ungranted/marker")
    for (const path of [
      secret,
      `${f.ro}/../ungranted/marker`,
      `/proc/self/root${secret}`,
      `/proc/1/root${secret}`,
      `/proc/${process.pid}/root${secret}`,
      `/proc/${process.pid}/environ`,
      join(f.appData, "bots/other/memory"),
      join(f.appData, "touri.db"),
      join(f.appData, "credential"),
      join(f.appData, "provider/other/auth.json"),
      join(f.home, ".ssh/key"),
      join(f.home, ".codex/sessions/private"),
      join(f.home, ".env"),
    ]) {
      const child = f.shell('cat "$1"', path)
      expect(child.exitCode).not.toBe(0)
      expect(child.stdout.toString()).toBe("")
    }
    // Create links after validation, just as an approved shell can do.
    for (const target of [secret, "../ungranted/marker", `/proc/self/root${secret}`]) {
      const child = f.shell('ln -s "$1" "$2/escape" && cat "$2/escape"', target, f.rw)
      expect(child.exitCode).not.toBe(0)
      expect(child.stdout.toString()).toBe("")
      rmSync(join(f.rw, "escape"), { force: true })
    }
    expect(f.shell('cat "$1"', join(f.ro, "reference.txt")).stdout.toString()).toBe("reference")
    if (provider === "codex")
      expect(f.shell('cat "$CODEX_HOME/auth.json"').stdout.toString()).toBe("current-provider-login")
    expect(f.shell('printf saved > "$1/saved"', f.rw).exitCode).toBe(0)
  })

const shellApprovalPolicies = ["on-request", "never"] as const

shellApprovalPolicies.forEach((approvals) => {
  test.skipIf(!available)(
    `Linux bounded providers enforce read-only grants with ${approvals} shell approvals`,
    async () => {
      const f = fixture({ approvals })

      expect(await runProviderShell(f, 'cat "$1"', join(f.ro, "reference.txt"))).toMatchObject({
        code: 0,
        stdout: "reference",
      })
      const denied = await runProviderShell(f, 'printf changed > "$1"', join(f.ro, "reference.txt"))
      expect(denied.code).not.toBe(0)
      expect(readFileSync(join(f.ro, "reference.txt"), "utf8")).toBe("reference")
      expect(await runProviderShell(f, 'printf saved > "$1"', join(f.rw, "saved.txt"))).toMatchObject({ code: 0 })
      expect(readFileSync(join(f.rw, "saved.txt"), "utf8")).toBe("saved")
      const outside = await runProviderShell(f, 'cat "$1"', join(f.home, "ungranted/marker"))
      expect(outside.code).not.toBe(0)
      expect(outside.stdout).toBe("")
    },
  )
})

test.skipIf(!available)("Linux full-access providers retain host access with saved RO grants", async () => {
  const f = fixture({ access: "full" })

  expect(
    await runProviderShell(
      f,
      'cat "$1"; cat "$2"; printf changed > "$1"; printf saved > "$3"',
      join(f.ro, "reference.txt"),
      join(f.home, "ungranted/marker"),
      join(f.home, "ungranted/saved"),
    ),
  ).toMatchObject({ code: 0, stdout: "referenceungranted-secret" })
  expect(readFileSync(join(f.ro, "reference.txt"), "utf8")).toBe("changed")
  expect(readFileSync(join(f.home, "ungranted/saved"), "utf8")).toBe("saved")
})

test.skipIf(!available)(
  "Linux hides API credentials and other bots while this bot and its runtime remain usable",
  () => {
    const f = fixture()
    expect(
      f.shell(
        'printf memory > "$1"; printf temp > "$TMPDIR/probe"; printf state > "$CODEX_HOME/state"',
        join(f.workspace, "memory"),
      ).exitCode,
    ).toBe(0)
    for (const path of [join(f.appData, "credential"), join(f.appData, "bots/other/memory"), join(f.home, ".ssh/key")])
      expect(f.shell('cat "$1"', path).exitCode).not.toBe(0)
    f.args.bot.anyFolderAccess = true
    expect(() => f.shell("true")).toThrow("adicione as pastas uma por uma")
  },
)

test.skipIf(!available)("Linux does not inherit host secrets, auth sockets or executable injection", () => {
  const f = fixture()
  Object.assign(f.args.env, {
    UNRELATED_SECRET: "host-secret-proof",
    UNRELATED_API_KEY: "host-secret-proof",
    ANTHROPIC_API_KEY: "other-provider-proof",
    SSH_AUTH_SOCK: "/run/private-agent",
    NODE_OPTIONS: "--require=/private/inject.js",
    BASH_ENV: "/private/inject.sh",
    ENV: "/private/inject.sh",
  })
  const result = f.shell("env")
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).not.toMatch(/host-secret-proof|other-provider-proof|private-agent|inject/)
  expect(result.stdout.toString()).toContain("HOME=/touri/home")
  expect(f.shell('printf private > "$HOME/state"').exitCode).toBe(0)
  expect(existsSync(join(f.home, "state"))).toBe(false)
  const mounts = linuxFolderSandbox(f.kernel, f.args, f.args.env, f.home)
  for (let index = 0; index < mounts.length; index++)
    if (["--bind", "--ro-bind"].includes(mounts[index] ?? "")) expect(mounts[index + 1]).not.toBe("/")
})

test.skipIf(!available)("Linux rejects a saved grant replaced with a symlink before spawn", () => {
  const f = fixture()
  rmSync(f.ro, { recursive: true })
  symlinkSync(join(f.home, "ungranted"), f.ro)
  expect(folderGrantProblem(f.args.bot)).not.toBeNull()
  expect(() => linuxFolderSandbox(f.kernel, f.args, f.args.env, f.home)).toThrow()
})

test.skipIf(!available)("a loose JavaScript executable cannot authorize its package ancestors", () => {
  const f = fixture()
  const script = join(f.home, "bin/helper.js")
  mkdirSync(join(f.home, "bin"))
  writeFileSync(join(f.home, "package.json"), '{"name":"private-home"}')
  writeFileSync(script, 'process.stdout.write(require("node:fs").readFileSync(process.argv[2], "utf8"))')
  f.args.mcp = { command: script, args: [], env: {} }
  for (const path of [join(f.home, "ungranted/marker"), join(f.home, ".ssh/key"), join(f.appData, "touri.db")]) {
    const child = f.shell('node "$1" "$2"', script, path)
    expect(child.exitCode).not.toBe(0)
    expect(child.stdout.toString()).toBe("")
  }
  expect(f.shell('node "$1" "$2"', script, join(f.ro, "reference.txt")).stdout.toString()).toBe("reference")
})

test.skipIf(!available)("only the active Codex endpoint's authentication variables survive", () => {
  const f = fixture()
  writeFileSync(
    join(f.args.env.CODEX_HOME ?? "", "config.toml"),
    [
      'model_provider = "selected"',
      "[model_providers.selected]",
      'env_key = "CUSTOM_ENDPOINT_TOKEN"',
      'env_http_headers = { "X-Account" = "CUSTOM_ACCOUNT_HEADER", "X-Unsafe" = "LD_PRELOAD" }',
      "[model_providers.other]",
      'env_key = "OTHER_ENDPOINT_TOKEN"',
    ].join("\n"),
  )
  Object.assign(f.args.env, {
    CUSTOM_ENDPOINT_TOKEN: "selected-proof",
    CUSTOM_ACCOUNT_HEADER: "account-proof",
    OTHER_ENDPOINT_TOKEN: "other-proof",
    LD_PRELOAD: "/private/inject.so",
  })
  const result = f.shell("env")
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain("CUSTOM_ENDPOINT_TOKEN=selected-proof")
  expect(result.stdout.toString()).toContain("CUSTOM_ACCOUNT_HEADER=account-proof")
  expect(result.stdout.toString()).not.toMatch(/other-proof|inject\.so/)
  expect(f.shell('printf changed > "$CODEX_HOME/config.toml"').exitCode).not.toBe(0)
  expect(f.shell('rm "$CODEX_HOME/config.toml"').exitCode).not.toBe(0)
})

test.skipIf(!available)("Claude keeps selected cloud authentication without unrelated host credentials", () => {
  const f = fixture()
  f.args.bot.provider = "claude"
  Object.assign(f.args.env, {
    ANTHROPIC_API_KEY: "selected-proof",
    AWS_ACCESS_KEY_ID: "cloud-id",
    AWS_SECRET_ACCESS_KEY: "cloud-secret",
    ANTHROPIC_FOUNDRY_API_KEY: "foundry-proof",
    UNRELATED_SECRET: "other-proof",
  })
  expect(f.shell("env").stdout.toString()).not.toMatch(/cloud-secret|foundry-proof|other-proof/)
  f.args.env.CLAUDE_CODE_USE_BEDROCK = "1"
  const result = f.shell("env")
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain("AWS_SECRET_ACCESS_KEY=cloud-secret")
  expect(result.stdout.toString()).not.toMatch(/foundry-proof|other-proof/)
  delete f.args.env.CLAUDE_CODE_USE_BEDROCK
  f.args.env.CLAUDE_CODE_USE_FOUNDRY = "1"
  expect(f.shell("env").stdout.toString()).toContain("ANTHROPIC_FOUNDRY_API_KEY=foundry-proof")
  expect(f.shell("env").stdout.toString()).not.toContain("cloud-secret")
})

test.skipIf(!available)("Claude binds only selected cloud credential files and the named auth helper", () => {
  const f = fixture()
  f.args.bot.provider = "claude"
  const login = join(f.home, "cloud-login.json")
  const helper = join(f.home, "auth-helper")
  writeFileSync(login, "selected-cloud-proof")
  writeFileSync(helper, "#!/bin/sh\nprintf helper-proof", { mode: 0o700 })
  const settings = join(f.kernel.paths.runDir, "claude/current-thread.settings.json")
  mkdirSync(join(f.kernel.paths.runDir, "claude"))
  writeFileSync(settings, JSON.stringify({ apiKeyHelper: `'${helper}'` }))
  Object.assign(f.args.env, { CLAUDE_CODE_USE_VERTEX: "1", GOOGLE_APPLICATION_CREDENTIALS: login })
  expect(f.shell('cat "$GOOGLE_APPLICATION_CREDENTIALS"').stdout.toString()).toBe("selected-cloud-proof")
  expect(f.shell('"$1"', helper).stdout.toString()).toBe("helper-proof")
  expect(f.shell('printf bad > "$GOOGLE_APPLICATION_CREDENTIALS"').exitCode).not.toBe(0)
  expect(f.shell('cat "$1"', join(f.home, ".env")).exitCode).not.toBe(0)
  rmSync(login)
  symlinkSync(join(f.appData, "touri.db"), login)
  expect(() => f.shell("true")).toThrow("login do bot com segurança")
})

test.skipIf(!available)("Claude cloud profiles retain only their configured credential leaves", () => {
  const f = fixture()
  f.args.bot.provider = "claude"
  mkdirSync(join(f.home, ".aws"))
  writeFileSync(join(f.home, ".aws/config"), "selected-config")
  writeFileSync(join(f.home, ".aws/credentials"), "selected-login")
  writeFileSync(join(f.home, ".aws/other-account"), "unrelated-login")
  Object.assign(f.args.env, { CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "selected" })
  expect(f.shell('printf "%s" "$AWS_PROFILE"').stdout.toString()).toBe("selected")
  expect(f.shell('cat "$AWS_SHARED_CREDENTIALS_FILE"').stdout.toString()).toBe("selected-login")
  expect(f.shell('cat "$AWS_CONFIG_FILE"').stdout.toString()).toBe("selected-config")
  expect(f.shell('cat "$1"', join(f.home, ".aws/other-account")).exitCode).not.toBe(0)
})

test.skipIf(!available)("noncanonical saved grants and a root workspace cannot widen the boundary", () => {
  const f = fixture()
  const alias = join(f.root, "alias")
  symlinkSync(f.home, alias)
  f.args.bot.folders = [{ path: join(alias, "reference"), access: "read-only" }]
  expect(() => linuxFolderSandbox(f.kernel, f.args, f.args.env, f.home)).toThrow()
  f.args.bot.folders = []
  f.args.fingerprint.cwd = "/"
  expect(() => linuxFolderSandbox(f.kernel, f.args, f.args.env, f.home)).toThrow()
})

test.skipIf(!available)("a provider with explicit folder grants cannot read ungranted host files", async () => {
  const f = fixture()
  rmSync(join(f.args.env.CODEX_HOME ?? "", "auth.json"))
  f.kernel.spawnTree = spawnTree
  const child = spawnFolderProvider(f.kernel, f.args, {
    cmd: "/bin/sh",
    args: ["-c", 'cat "$1"', "test", join(f.home, "ungranted/marker")],
    cwd: f.workspace,
    env: f.args.env,
  })
  expect(child.success).toBe(true)
  if (!child.success) return
  const [output, result] = await Promise.all([new Response(child.stdout).text(), child.exited])
  expect(result.code).not.toBe(0)
  expect(output).toBe("")
})

test.skipIf(!available)("a grant-free provider launches directly with provider-owned sandbox policy", async () => {
  const launch = Promise.withResolvers<Parameters<Kernel["spawnTree"]>[0]>()
  const f = fixture({
    grantFree: true,
    spawn: (input) => {
      launch.resolve(input)
      return spawnTree(input)
    },
  })
  const input = {
    cmd: "/bin/sh",
    args: ["-c", 'cat "$1"', "test", join(f.home, "ungranted/marker")],
    cwd: f.workspace,
    env: f.args.env,
  }

  const child = spawnFolderProvider(f.kernel, f.args, input)
  expect(child.success).toBe(true)
  if (!child.success) throw new Error(child.error)
  expect(await launch.promise).toEqual(input)
  // This shell probes the launcher. Codex receives its own sandbox policy;
  // settings-isolation also asserts that policy at the adapter protocol boundary.
  const [output, stderr, result] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ code: result.code, output, stderr }).toEqual({ code: 0, output: "ungranted-secret", stderr: "" })
  expect(codexAccessParams(f.args)).toMatchObject({
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    config: { sandbox_workspace_write: { writable_roots: expect.arrayContaining([f.workspace]) } },
  })
})

test.skipIf(!available)("the actual provider spawn drops unrelated credentials before entering bwrap", async () => {
  const f = fixture()
  // This synthetic HOME is not the host login selected by the real spawn path.
  rmSync(join(f.args.env.CODEX_HOME ?? "", "auth.json"))
  f.kernel.spawnTree = spawnTree
  const child = spawnFolderProvider(f.kernel, f.args, {
    cmd: "/usr/bin/env",
    args: [],
    cwd: f.workspace,
    env: { ...f.args.env, UNRELATED_SECRET: "host-secret-proof", SSH_AUTH_SOCK: "/private/agent" },
  })
  expect(child.success).toBe(true)
  if (!child.success) return
  const [output, result] = await Promise.all([new Response(child.stdout).text(), child.exited])
  expect(result.code).toBe(0)
  expect(output).not.toMatch(/host-secret-proof|private\/agent/)
  expect(output).toContain("HOME=/touri/home")
})

test.skipIf(!available)("host temporary directories and shared provider history are not implicit grants", () => {
  const f = fixture()
  f.args.env.TMPDIR = f.home
  expect(f.shell('cat "$1"', join(f.home, ".env")).exitCode).not.toBe(0)
  f.args.bot.provider = "claude"
  const source = f.args.env.CODEX_HOME ?? ""
  f.args.env.CLAUDE_CONFIG_DIR = source
  writeFileSync(join(source, "history.jsonl"), "private-history")
  writeFileSync(join(source, ".credentials.json"), "current-login")
  expect(f.shell('cat "$1"', join(source, "history.jsonl")).exitCode).not.toBe(0)
  expect(f.shell('cat "$CLAUDE_CONFIG_DIR/.credentials.json"').stdout.toString()).toBe("current-login")
  expect(f.shell('printf state > "$CLAUDE_CONFIG_DIR/state"').exitCode).toBe(0)
})

test.skipIf(!available)("a linked login exposes only the required credential leaf", () => {
  const f = fixture()
  const config = join(f.home, ".codex/login")
  mkdirSync(config)
  writeFileSync(join(config, "current-auth.json"), "current-login")
  writeFileSync(join(config, "other-auth.json"), "other-login")
  const auth = join(f.home, ".codex/auth.json")
  rmSync(auth)
  symlinkSync(join(config, "current-auth.json"), auth)
  expect(f.shell('cat "$CODEX_HOME/auth.json"').stdout.toString()).toBe("current-login")
  expect(f.shell('cat "$1"', join(config, "other-auth.json")).exitCode).not.toBe(0)
  expect(f.shell('cat "$1"', join(f.home, ".codex/sessions/private")).exitCode).not.toBe(0)
})

test.skipIf(!available)("credential symlinks cannot smuggle protected or ungranted files into the mounts", () => {
  const f = fixture()
  const providerHome = f.args.env.CODEX_HOME ?? ""
  for (const target of [
    join(f.appData, "touri.db"),
    join(f.appData, "provider/other/auth.json"),
    join(f.home, ".env"),
  ]) {
    rmSync(join(providerHome, "auth.json"), { force: true })
    symlinkSync(target, join(providerHome, "auth.json"))
    expect(() => linuxFolderSandbox(f.kernel, f.args, f.args.env, f.home)).toThrow("login do bot com segurança")
    f.args.bot.provider = "claude"
    f.args.env.CLAUDE_CONFIG_DIR = providerHome
    symlinkSync(target, join(providerHome, ".credentials.json"))
    expect(() => linuxFolderSandbox(f.kernel, f.args, f.args.env, f.home)).toThrow("login do bot com segurança")
    rmSync(join(providerHome, ".credentials.json"))
    f.args.bot.provider = "codex"
  }
})

test.skipIf(!available)("a managed login link cannot expose unrelated host provider history", () => {
  const f = fixture()
  const auth = join(f.args.env.CODEX_HOME ?? "", "auth.json")
  rmSync(auth)
  symlinkSync(join(f.home, ".codex/sessions/private"), auth)
  expect(() => f.shell('cat "$CODEX_HOME/auth.json"')).toThrow("login do bot com segurança")
})

test.skipIf(!available)("saved system filesystem grants are incompatible before provider startup", () => {
  const f = fixture()
  for (const path of ["/proc", "/proc/sys", "/sys", "/dev", "/dev/shm"])
    expect(folderGrantProblem({ ...f.args.bot, folders: [{ path, access: "read-only" }] })).not.toBeNull()
})

test.skipIf(!available)("Linux read-only bot keeps user files immutable and runtime writable", () => {
  const f = fixture()
  f.args.bot.access = "read-only"
  expect(f.shell('printf state > "$CODEX_HOME/state"').exitCode).toBe(0)
  for (const path of [join(f.rw, "bad"), join(f.workspace, "bad")]) {
    expect(f.shell('printf bad > "$1"', path).exitCode).not.toBe(0)
    expect(existsSync(path)).toBe(false)
  }
})

test.skipIf(!available)(
  "Linux keeps a temporary MCP executable readable without exposing other temporary files",
  () => {
    const f = fixture()
    const executable = join(f.root, "mcp-helper")
    writeFileSync(executable, "#!/bin/sh\nprintf helper-ready", { mode: 0o700 })
    f.args.mcp = { command: executable, args: [], env: {} }
    expect(f.shell('"$1"', executable).stdout.toString()).toBe("helper-ready")
    expect(f.shell('printf bad > "$1"', executable).exitCode).not.toBe(0)
  },
)

test.skipIf(!available)(
  "Linux confines subprocesses, symlink writes, process-root aliases and remount attempts",
  () => {
    const f = fixture()
    // Create the link inside the namespace, after the grant's validation.
    expect(
      f.shell(
        'ln -s "$1" "$2/link"; /bin/sh -c \'printf bad > "$1/link"\' test "$2"',
        join(f.ro, "reference.txt"),
        f.rw,
      ).exitCode,
    ).not.toBe(0)
    rmSync(join(f.rw, "link"))
    expect(f.shell('printf bad > "/proc/self/root$1"', join(f.ro, "reference.txt")).exitCode).not.toBe(0)
    expect(f.shell('mount -o remount,rw "$1"', f.ro).exitCode).not.toBe(0)
    expect(
      f.shell(
        'unshare -Urnm -- /bin/sh -c \'mount -o remount,rw "$1" && printf bad > "$1/reference.txt"\' test "$1"',
        f.ro,
      ).exitCode,
    ).not.toBe(0)
    expect(readFileSync(join(f.ro, "reference.txt"), "utf8")).toBe("reference")
    expect(f.shell('ln "$1" "$2/hardlink"', join(f.ro, "reference.txt"), f.rw).exitCode).not.toBe(0)
    symlinkSync(join(f.home, "ungranted"), join(f.rw, "escape"))
    // Later turns keep working with the same saved grant. Its new link still
    // cannot reach the unbound target in the next fresh namespace.
    expect(f.shell('cat "$1/escape/marker"', f.rw).exitCode).not.toBe(0)
    expect(f.shell("printf ready").stdout.toString()).toBe("ready")
  },
)

test.skipIf(!available)(
  "a RO home grant keeps managed bookkeeping writable and ignores unrelated provider environment",
  () => {
    const f = fixture()
    f.args.bot.folders = [{ path: f.home, access: "read-only" }]
    f.args.env.XDG_DATA_HOME = f.home
    expect(f.shell('printf state > "$CODEX_HOME/state"').exitCode).toBe(0)
    expect(f.shell('printf bad > "$1"', join(f.ro, "reference.txt")).exitCode).not.toBe(0)
    expect(f.shell('printf bad > "$1"', join(f.workspace, "bad")).exitCode).not.toBe(0)
    expect(f.shell('cat "$1"', join(f.appData, "credential")).exitCode).not.toBe(0)
  },
)

test("Linux capability fails closed when namespaces are unavailable even with bwrap installed", async () => {
  if (process.platform !== "linux") return
  const probe = spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("namespaces unavailable")
  })
  try {
    expect(await refreshHostFolderAccess()).toBe(false)
  } finally {
    probe.mockRestore()
  }
})
