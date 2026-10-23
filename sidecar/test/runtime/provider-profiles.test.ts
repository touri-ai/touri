import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Kernel, ProviderProfile, StartTurnArgs, Thread } from "@touri/contracts"
import { parseCli } from "../../src/cli/args"
import { createKernel } from "../../src/kernel"
import { providerProfileEnv, validProviderProfileName } from "../../src/kernel/provider-profiles"
import { createClaudeAdapter } from "../../src/runtime/claude/adapter"
import { listProviderProfiles } from "../../src/runtime/provider-profiles"
import { sessionFingerprint } from "../../src/runtime/session"
import { writePrivateFile } from "../../src/runtime/utils"
import { init as initStore } from "../../src/store"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

const tempRoot = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touri-profiles-")))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test("profile names stay one safe path segment", () => {
  for (const name of ["clav", "Woovi_2", "pessoal.bots", "a-b"]) expect(validProviderProfileName(name)).toBe(true)
  for (const name of ["", ".", "..", "../x", "a/b", "-lead", "a..b", "x".repeat(64), 7, null])
    expect(validProviderProfileName(name)).toBe(false)
})

test("only local Claude and Codex bots get a profile home", () => {
  const appData = "/data"
  expect(
    providerProfileEnv({ appData, bot: { provider: "claude", machine: "local", providerProfile: "clav" } }),
  ).toEqual({ CLAUDE_CONFIG_DIR: "/data/provider-profiles/clav/claude" })
  expect(
    providerProfileEnv({ appData, bot: { provider: "codex", machine: "local", providerProfile: "clav" } }),
  ).toEqual({
    CODEX_HOME: "/data/provider-profiles/clav/codex",
  })
  expect(providerProfileEnv({ appData, bot: { provider: "claude", machine: "vm", providerProfile: "clav" } })).toEqual(
    {},
  )
  expect(
    providerProfileEnv({ appData, bot: { provider: "opencode", machine: "local", providerProfile: "clav" } }),
  ).toEqual({})
  expect(
    providerProfileEnv({ appData, bot: { provider: "claude", machine: "local", providerProfile: "../x" } }),
  ).toEqual({})
  expect(providerProfileEnv({ appData, bot: { provider: "claude", machine: "local", providerProfile: null } })).toEqual(
    {},
  )
})

test("the profile is part of the session fingerprint only when set", () => {
  const bot = { provider: "claude", access: "full", browserEnabled: true, computerUse: false, approvals: "on-request" }
  const plain = sessionFingerprint({ bot: bot as Bot, cwd: "/w", mcpCommand: "m", mcpArgs: [] })
  const unset = sessionFingerprint({
    bot: { ...bot, providerProfile: null, claudeAiConnectors: false } as Bot,
    cwd: "/w",
    mcpCommand: "m",
    mcpArgs: [],
  })
  const profiled = sessionFingerprint({
    bot: { ...bot, providerProfile: "clav" } as Bot,
    cwd: "/w",
    mcpCommand: "m",
    mcpArgs: [],
  })
  expect(unset.hash).toBe(plain.hash)
  expect(profiled.hash).not.toBe(plain.hash)
})

test("profiles list the account Claude reports and Codex login presence, never the credential", async () => {
  const root = tempRoot()
  const appData = join(root, "data")
  const claudeHome = join(appData, "provider-profiles", "clav", "claude")
  const emptyHome = join(appData, "provider-profiles", "woovi", "claude")
  const codexHome = join(appData, "provider-profiles", "lumx", "codex")
  for (const dir of [claudeHome, emptyHome, codexHome, join(appData, "provider-profiles", "..hidden")])
    mkdirSync(dir, { recursive: true })
  writeFileSync(join(claudeHome, "signed-in"), "")
  writeFileSync(join(codexHome, "auth.json"), "{}")
  const bin = join(root, "bin")
  mkdirSync(bin)
  const fake = join(bin, "claude")
  writeFileSync(
    fake,
    `#!/bin/sh\nif [ -f "$CLAUDE_CONFIG_DIR/signed-in" ]; then echo '{"loggedIn":true,"email":"ops@example.test"}'; else echo '{"loggedIn":false}'; fi\n`,
  )
  chmodSync(fake, 0o755)
  const previous = process.env.TOURI_CLAUDE_BIN
  process.env.TOURI_CLAUDE_BIN = fake
  cleanups.push(() => {
    if (previous === undefined) delete process.env.TOURI_CLAUDE_BIN
    else process.env.TOURI_CLAUDE_BIN = previous
  })
  const profiles = await listProviderProfiles({ appData, env: { PATH: "/usr/bin:/bin" } })
  expect(profiles).toEqual<Array<ProviderProfile>>([
    { name: "clav", provider: "claude", loggedIn: true, account: "ops@example.test" },
    { name: "lumx", provider: "codex", loggedIn: true, account: null },
    { name: "woovi", provider: "claude", loggedIn: false, account: null },
  ])
})

test("bots store a profile and the connectors opt-in through the authenticated API", async () => {
  const root = tempRoot()
  const runtime = createKernel({ appData: join(root, "data") })
  await initStore(runtime.kernel)
  cleanups.push(() => runtime.stop())
  const request = (path: string, body: unknown, method = "PATCH") =>
    fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
      method,
      headers: {
        Authorization: "Bearer dev-ui-token",
        "Content-Type": "application/json",
        Origin: "tauri://localhost",
      },
      body: JSON.stringify(body),
    })
  const created = await request("/bots", { name: "Mail", provider: "claude" }, "POST")
  const { bot } = (await created.json()) as { bot: Bot }
  expect(bot).toMatchObject({ providerProfile: null, claudeAiConnectors: false })
  const updated = await request(`/bots/${bot.id}`, { providerProfile: "clav", claudeAiConnectors: true })
  expect(updated.status).toBe(200)
  expect(((await updated.json()) as { bot: Bot }).bot).toMatchObject({
    providerProfile: "clav",
    claudeAiConnectors: true,
  })
  const kept = await request(`/bots/${bot.id}`, { title: "Inbox" })
  expect(((await kept.json()) as { bot: Bot }).bot).toMatchObject({ providerProfile: "clav", claudeAiConnectors: true })
  expect((await request(`/bots/${bot.id}`, { providerProfile: "../escape" })).status).toBe(400)
  expect((await request(`/bots/${bot.id}`, { claudeAiConnectors: "yes" })).status).toBe(400)
  expect((await request(`/bots/${bot.id}`, { provider: "opencode" })).status).toBe(400)
  const codex = await request(`/bots/${bot.id}`, { provider: "codex" })
  expect(((await codex.json()) as { bot: Bot }).bot).toMatchObject({
    providerProfile: "clav",
    claudeAiConnectors: false,
  })
  const cleared = await request(`/bots/${bot.id}`, { providerProfile: null })
  expect(((await cleared.json()) as { bot: Bot }).bot.providerProfile).toBeNull()
})

const claudeFixture = (connectors: boolean, vm = false) => {
  const root = tempRoot()
  const runtime = createKernel({ appData: join(root, "data") })
  const scenario = join(root, "scenario.json")
  writeFileSync(
    scenario,
    JSON.stringify({ events: [{ type: "delta", delta: "Synthetic response." }, { type: "complete" }] }),
  )
  mkdirSync(join(root, "home", ".claude"), { recursive: true })
  const calls: Array<Parameters<Kernel["spawnTree"]>[0]> = []
  const spawn: Kernel["spawnTree"] = (input) => {
    if (input.cmd === "cat") return runtime.kernel.spawnTree({ ...input, cmd: "/bin/cat" })
    calls.push(input)
    return runtime.kernel.spawnTree({
      ...input,
      cmd: process.execPath,
      args: [
        "run",
        join(import.meta.dir, "../fakes/fake-claude.ts"),
        ...(input.cmd === "/usr/bin/sandbox-exec"
          ? input.args.slice(3)
          : /\/bwrap$/.test(input.cmd)
            ? input.args.slice(input.args.indexOf("--") + 2)
            : input.args),
      ],
    })
  }
  const adapter = createClaudeAdapter({ kernel: { ...runtime.kernel, spawnTree: spawn }, command: process.execPath })
  const home = join(root, "home")
  const args: StartTurnArgs = {
    bot: {
      provider: "claude",
      access: "full",
      approvals: "on-request",
      homeDir: home,
      model: null,
      reasoningEffort: null,
      claudeAiConnectors: connectors,
    } as Bot,
    thread: { id: "thread-connectors" } as Thread,
    session: null,
    fingerprint: { cwd: home } as StartTurnArgs["fingerprint"],
    input: [{ type: "text", text: "hi" }],
    developerInstructions: "Test connectors.",
    handoffPacket: null,
    mcp: { command: process.execPath, args: [], env: {} },
    env: {
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      TOURI_RUN_DIR: runtime.kernel.paths.runDir,
      TOURI_FAKE_SCENARIO: scenario,
    },
    signal: new AbortController().signal,
    onEvent: () => {},
    ...(vm ? { execution: { spawn, writeFile: async (file) => writePrivateFile({ ...file, root }) } } : {}),
  }
  cleanups.push(async () => {
    await adapter.shutdown()
    await runtime.stop()
  })
  return { adapter, args, calls }
}

for (const [connectors, vm, strict] of [
  [false, false, true],
  [true, false, false],
  [true, true, true],
] as const)
  test(`claude.ai connectors ${connectors ? "on" : "off"} on ${vm ? "a VM" : "the host"} ${strict ? "keeps" : "drops"} strict MCP`, async () => {
    const f = claudeFixture(connectors, vm)
    expect((await f.adapter.startTurn(f.args)).success).toBe(true)
    const call = f.calls[0]
    if (!call) throw new Error("Missing spawn")
    expect(call.args.includes("--strict-mcp-config")).toBe(strict)
    expect(call.args).toContain("--setting-sources=")
    const config = JSON.parse(readFileSync(call.args[call.args.indexOf("--mcp-config") + 1] ?? "", "utf8"))
    expect(Object.keys(config.mcpServers)).toEqual(["touri"])
  })

test("CLI parses profile commands and rejects unsafe names", () => {
  expect(parseCli(["profile", "list", "--data-dir", "/d"])).toEqual({
    success: true,
    command: { name: "profile-list", dataDir: "/d" },
  })
  expect(parseCli(["profile", "login", "clav", "--data-dir", "/d"])).toEqual({
    success: true,
    command: { name: "profile-login", dataDir: "/d", profile: "clav", provider: "claude" },
  })
  expect(parseCli(["profile", "login", "lumx", "--provider", "codex", "--data-dir", "/d"])).toMatchObject({
    success: true,
    command: { provider: "codex" },
  })
  expect(parseCli(["profile", "login", "../x"]).success).toBe(false)
  expect(parseCli(["profile", "login", "clav", "--provider", "opencode"]).success).toBe(false)
})
