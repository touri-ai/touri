import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Kernel, ProviderLoginFlow, UiEvent } from "@touri/contracts"
import { createRedactor } from "../../src/kernel/redact"
import { spawnTree } from "../../src/kernel/spawn"
import { prepareLocalProviderLogin } from "../../src/vm/local-provider-login"
import { providerLoginAccount, storedProviderLoginSource } from "../../src/vm/provider-login"
import { createProviderLoginFlow, type LoginInvocation, validLogin } from "../../src/vm/provider-login-flow"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})
const token = "sk-ant-oat01-synthetic-oauth-test-value"
const browserCode = "synthetic-browser-code"
const authorizeUrl =
  "https://claude.com/cai/oauth/authorize?client_id=touri-test&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode&state=synthetic-state&code_challenge=synthetic-challenge"
const codex = JSON.stringify({ tokens: { access_token: "synthetic-access", refresh_token: "synthetic-refresh" } })
const openCode = JSON.stringify({
  openai: { type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 60_000 },
})
const fixture = (
  provider: Bot["provider"] = "codex",
  mode = "success",
  timeoutMs = 3000,
  options: { bridge?: boolean; url?: string; platform?: NodeJS.Platform; headless?: boolean } = {},
) => {
  const root = mkdtempSync(join(tmpdir(), "touri-flow-test-"))
  const db = new Database(":memory:")
  db.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT, updated_at INTEGER)")
  const vault = new Map<string, string>()
  const redactions: string[] = []
  const redactor = createRedactor()
  const invocations: LoginInvocation[] = []
  const kills: string[] = []
  const children: Array<Extract<ReturnType<Kernel["spawnTree"]>, { success: true }>> = []
  const trackedSpawn: Kernel["spawnTree"] = (input) => {
    const child = spawnTree(input)
    if (!child.success) return child
    children.push(child)
    return {
      ...child,
      kill: (signal) => {
        kills.push(signal)
        child.kill(signal)
      },
    }
  }
  let listener: (event: UiEvent) => void = () => {}
  const bot = { id: "login-bot", provider, machine: "local" } as Bot
  const script = join(root, "fake-cli.ts")
  writeFileSync(
    script,
    `
    import { writeFileSync } from "node:fs"
    import { join } from "node:path"
    import { createInterface } from "node:readline"
    const [provider, mode] = process.argv.slice(2)
    console.log("Open https://auth.openai.com/codex/device and enter code: ABCD-EFGH")
    if (mode === "wait") await Bun.sleep(30000)
    if (mode === "fail") { console.error("synthetic-secret-error"); process.exit(1) }
    if (mode === "menu") {
      console.log("Select provider\\n│ ● OpenAI\\n│ ○ Anthropic")
      await new Promise((resolve) => process.stdin.once("data", resolve))
      console.log("Select login method\\n│ ● ChatGPT Pro")
      await new Promise((resolve) => process.stdin.once("data", resolve))
    }
    if (provider === "claude" && mode.startsWith("code-")) {
      const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]()
      const url = ${JSON.stringify(options.url ?? authorizeUrl)}
      const end = mode === "code-st" ? "\\x1b\\\\" : "\\x07"
      console.log("Opening browser to sign in…")
      console.log("Browser didn't open? Use the url below to sign in (c to copy)")
      const link = "\\x1b]8;id=login;" + url + end + url.replace("?", "?\\n") + "\\x1b]8;;" + end
      // Split the OSC sequence across output chunks too.
      process.stdout.write(link.slice(0, 30))
      await Bun.sleep(10)
      console.log(link.slice(30))
      console.log("\\x1b[32mPaste code here if prompted >\\x1b[0m")
      let code = (await lines.next()).value
      console.log(code)
      if (mode === "code-retry") {
        if (code !== "synthetic-wrong-code") process.exit(2)
        console.log("OAuth error: Invalid code. Please make sure the full code was copied")
        console.log("Press Enter to retry.")
        if ((await lines.next()).value !== "") process.exit(3)
        const early = () => process.exit(4)
        process.stdin.on("data", early)
        await Bun.sleep(50)
        process.stdin.off("data", early)
        console.log("Paste code here if prompted >")
        code = (await lines.next()).value
      }
      if (code !== ${JSON.stringify(browserCode)}) process.exit(5)
    }
    if (provider === "claude") console.log(mode === "wrapped" ? ${JSON.stringify(token)} + "\\n  synthetic-wrapped-continuation" : ${JSON.stringify(token)})
    else writeFileSync(join(process.env.HOME!, provider === "codex" ? ".codex/auth.json" : ".local/share/opencode/auth.json"), mode === "invalid" ? "{}" : provider === "codex" ? ${JSON.stringify(codex)} : ${JSON.stringify(openCode)})
    process.exit(0)
  `,
  )
  const bin = join(root, "fake bin")
  mkdirSync(bin)
  writeFileSync(join(bin, provider), "#!/bin/sh\nexit 93\n", { mode: 0o700 })
  if (options.bridge) {
    writeFileSync(
      join(bin, "claude"),
      `#!/bin/sh
[ -t 0 ] && [ -t 1 ] && [ "$1" = setup-token ] || exit 2
echo $$ > "$HOME/cli.pid"
printf 'Paste code here if prompted >\\n'
IFS= read -r code < /dev/tty
[ "$code" = '${browserCode}' ] || exit 3
printf '%s\\n' '${token}'
`,
      { mode: 0o700 },
    )
  }
  const kernel = {
    db,
    paths: { runDir: root },
    spawnTree: (input: Parameters<Kernel["spawnTree"]>[0]) => {
      invocations.push({ provider, ...input })
      return trackedSpawn(input)
    },
    services: { use: () => ({ getBot: ({ botId }: { botId: string }) => (botId === bot.id ? bot : null) }) },
    shellEnv: async () => ({ HOME: root, PATH: bin }),
    redact: redactor.redact,
    addRedactionValue: (value: string) => {
      redactions.push(value)
      redactor.addRedactionValue(value)
    },
    subscribe: (callback: Parameters<Kernel["subscribe"]>[0]) => {
      listener = (event) => callback({ event, seq: 1, at: Date.now() })
      return () => {}
    },
    callHost: async (method: string, input: { account: string; value?: string }) => {
      if (method === "keychain.set") vault.set(input.account, input.value ?? "")
      if (method === "keychain.delete") vault.delete(input.account)
      return { success: true, value: { value: vault.get(input.account) ?? null } }
    },
  } as unknown as Kernel
  const flow = createProviderLoginFlow({
    kernel,
    hostHome: root,
    timeoutMs,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.headless === undefined ? {} : { headless: options.headless }),
    ...(options.bridge
      ? {}
      : {
          invoke: (input: LoginInvocation) => {
            invocations.push(input)
            return trackedSpawn({ ...input, cmd: process.execPath, args: [script, input.provider, mode] })
          },
        }),
  })
  cleanups.push(() => {
    flow.dispose()
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    flow,
    kernel,
    bot,
    root,
    vault,
    redactions,
    invocations,
    kills,
    children,
    emit: (event: UiEvent) => listener(event),
  }
}
const waitView = async (f: ReturnType<typeof fixture>, predicate: (view: ProviderLoginFlow) => boolean) => {
  for (let attempt = 0; attempt < 150; attempt++) {
    const view = await f.flow.status(f.bot)
    if (predicate(view)) return view
    if (view.state === "error") throw new Error(view.message)
    await Bun.sleep(10)
  }
  throw new Error("Login did not reach the expected view")
}
const waitState = (f: ReturnType<typeof fixture>, state: string) => waitView(f, (view) => view.state === state)

for (const provider of ["claude", "codex", "opencode"] as const)
  test(`${provider}: official login invocation captures credentials privately into this bot's vault`, async () => {
    const f = fixture(provider)
    expect((await f.flow.status(f.bot)).state).toBe("idle")
    expect((await f.flow.action(f.bot, { action: "start" })).state).toBe("waiting")
    await f.flow.action(f.bot, { action: "start" })
    expect(await waitState(f, "ready")).toEqual({ provider, state: "ready" })
    expect(f.invocations).toHaveLength(1)
    const invocation = f.invocations[0]
    expect(invocation?.args).toEqual(
      provider === "claude"
        ? ["setup-token"]
        : provider === "codex"
          ? ["-c", 'cli_auth_credentials_store="file"', "login", "--device-auth"]
          : ["auth", "login"],
    )
    const secret = f.vault.get(providerLoginAccount(f.bot.id, provider))
    expect(secret).toBe(provider === "claude" ? token : provider === "codex" ? codex : openCode)
    expect(f.redactions).toContain(secret ?? "")
    expect(JSON.stringify(await f.flow.status(f.bot))).not.toContain(secret ?? "unexpected")
    expect(storedProviderLoginSource(f.kernel, f.bot)).toBe("vault")
    expect(existsSync(invocation?.cwd ?? "")).toBe(false)
  })

test("poll exposes only device challenge, cancel kills CLI and never saves credentials", async () => {
  const f = fixture("codex", "wait")
  await f.flow.action(f.bot, { action: "start" })
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await f.flow.status(f.bot)).deviceCode) break
    await Bun.sleep(10)
  }
  expect(await f.flow.status(f.bot)).toEqual({
    provider: "codex",
    state: "waiting",
    deviceCode: "ABCD-EFGH",
    verificationUrl: "https://auth.openai.com/codex/device",
  })
  expect((await f.flow.action(f.bot, { action: "cancel" })).state).toBe("cancelled")
  expect(f.kills).toContain("SIGKILL")
  expect(f.vault.size).toBe(0)
})

test("timeout kills the spawned CLI and offers retry without saving", async () => {
  const f = fixture("codex", "wait", 300)
  await f.flow.action(f.bot, { action: "start" })
  const view = await waitState(f, "error")
  expect(view.message).toContain("expirou")
  expect(f.kills).toContain("SIGKILL")
  expect(f.vault.size).toBe(0)
})

for (const mode of ["invalid", "fail"])
  test(`CLI ${mode} is recoverable and never exposes output`, async () => {
    const f = fixture("codex", mode)
    await f.flow.action(f.bot, { action: "start" })
    expect(JSON.stringify(await waitState(f, "error"))).not.toContain("synthetic-secret-error")
    expect(f.vault.size).toBe(0)
  })

for (const [platform, headless, host] of [
  ["darwin", false, "mac"],
  ["darwin", true, "server"],
  ["linux", true, "server"],
  ["linux", false, "server"],
] as const)
  for (const provider of ["claude", "codex"] as const) {
    const directory = provider === "claude" ? ".claude" : ".codex"
    const filename = provider === "claude" ? ".credentials.json" : "auth.json"
    test(`${provider} on ${platform} (headless=${headless}): offers only a valid host file with its host context`, async () => {
      const f = fixture(provider, "success", 3000, { platform, headless })
      expect((await f.flow.status(f.bot)).state).toBe("idle")
      await expect(f.flow.action(f.bot, { action: "use-host" })).rejects.toThrow()
      mkdirSync(join(f.root, directory))
      const path = join(f.root, directory, filename)
      writeFileSync(path, "{}")
      expect((await f.flow.status(f.bot)).state).toBe("idle")
      await expect(f.flow.action(f.bot, { action: "use-host" })).rejects.toThrow()
      if (provider === "claude") {
        writeFileSync(path, JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: 1 } }))
        expect((await f.flow.status(f.bot)).state).toBe("idle")
        await expect(f.flow.action(f.bot, { action: "use-host" })).rejects.toThrow()
      }
      const value =
        provider === "claude"
          ? JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 60_000 } })
          : codex
      writeFileSync(path, value)
      const route = f.flow.routes[0]
      if (!route) throw new Error("Missing route")
      const response = await route.handler({
        params: { id: f.bot.id },
        query: { provider },
        body: {},
        signal: new AbortController().signal,
      })
      expect(response).toEqual({
        status: 200,
        json: { provider, state: "host-available", host, executable: "available" },
      })
      expect(f.invocations).toHaveLength(0)
      expect((await f.flow.action(f.bot, { action: "use-host" })).state).toBe("ready")
      expect(storedProviderLoginSource(f.kernel, f.bot)).toBe("host-file")
      expect(f.vault.size).toBe(0)
      rmSync(path)
      expect((await f.flow.status(f.bot)).state).toBe("idle")
      await expect(f.flow.action(f.bot, { action: "use-host" })).rejects.toThrow()
    })
  }

test("empty or expired host credentials are not offered", () => {
  expect(validLogin("codex", "{}", true)).toBe(false)
  expect(validLogin("claude", JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: 1 } }), true)).toBe(
    false,
  )
  expect(validLogin("opencode", "[]", true)).toBe(false)
})

test("creation draft login is adopted by the created bot's vault, never returned to UI", async () => {
  const f = fixture("claude")
  const draft = { ...f.bot, id: "draft-00000000-0000-4000-8000-000000000000" }
  await f.flow.action(draft, { action: "paste", value: token })
  expect(f.vault.size).toBe(0)
  expect(JSON.stringify(await f.flow.status(draft))).not.toContain(token)
  await f.flow.action(f.bot, { action: "adopt", draftId: draft.id })
  expect(f.vault.get(providerLoginAccount(f.bot.id, "claude"))).toBe(token)
})

test("creation adoption route recovers from a temporary vault failure and accepts a repeated request", async () => {
  const f = fixture("claude")
  const draft = { ...f.bot, id: "draft-00000000-0000-4000-8000-000000000000" }
  await f.flow.action(draft, { action: "paste", value: token })
  const route = f.flow.routes.find((route) => route.method === "POST")
  if (!route) throw new Error("Missing route")
  const request = {
    params: { id: f.bot.id },
    query: {},
    body: { provider: "claude", action: "adopt", draftId: draft.id },
    signal: new AbortController().signal,
  }
  const callHost = f.kernel.callHost
  f.kernel.callHost = async () => ({ success: false, errorCode: "HOST_ERROR", error: "unavailable" })
  expect((await route.handler(request)).status).toBe(503)
  expect((await f.flow.status(draft)).state).toBe("ready")
  f.kernel.callHost = callHost
  expect((await route.handler(request)).status).toBe(200)
  expect((await route.handler(request)).status).toBe(200)
  expect(f.vault.get(providerLoginAccount(f.bot.id, "claude"))).toBe(token)
})

test("paste fallback validates and saves to the selected provider even before config is saved", async () => {
  const f = fixture("claude")
  const target = { ...f.bot, provider: "codex" as const }
  await expect(f.flow.action(target, { action: "paste", value: "[]" })).rejects.toThrow()
  await f.flow.action(target, { action: "paste", value: codex })
  expect(f.vault.get(providerLoginAccount(f.bot.id, "codex"))).toBe(codex)
  expect(f.vault.has(providerLoginAccount(f.bot.id, "claude"))).toBe(false)
})

test("new routes reject unknown bots, cloud bots and invalid provider input", async () => {
  const f = fixture()
  const route = f.flow.routes[0]
  if (!route) throw new Error("Missing route")
  const request = {
    params: { id: "missing" },
    query: { provider: "codex" },
    body: {},
    signal: new AbortController().signal,
  }
  expect((await route.handler(request)).status).toBe(404)
  request.params.id = f.bot.id
  request.query.provider = "invalid"
  expect((await route.handler(request)).status).toBe(400)
  request.query.provider = "codex"
  f.bot.machine = "cloud"
  expect((await route.handler(request)).status).toBe(403)
})

test("OpenCode provider and method menus accept only navigation keys through the CLI stdin", async () => {
  const f = fixture("opencode", "menu")
  await f.flow.action(f.bot, { action: "start" })
  const prompt = async (kind: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const view = await f.flow.status(f.bot)
      if (view.prompt?.kind === kind) return view.prompt
      await Bun.sleep(10)
    }
    throw new Error("No CLI menu")
  }
  expect((await prompt("provider")).choice).toBe("OpenAI")
  await expect(f.flow.action(f.bot, { action: "input", input: "secret" })).rejects.toThrow()
  await f.flow.action(f.bot, { action: "input", input: "enter" })
  expect((await prompt("method")).choice).toBe("ChatGPT Pro")
  await f.flow.action(f.bot, { action: "input", input: "enter" })
  await waitState(f, "ready")
})

test("vault failure leaves login retryable, never ready", async () => {
  const f = fixture("claude", "success", 3000, { platform: "darwin", headless: false })
  f.kernel.callHost = async () => ({ success: false, errorCode: "HOST_ERROR", error: "synthetic-secret-error" })
  await expect(f.flow.action(f.bot, { action: "paste", value: token })).rejects.toThrow()
  expect(await f.flow.status(f.bot)).toMatchObject({ state: "vault-locked" })
})

test("cancel during a pending vault write removes the late credential without activating it", async () => {
  const f = fixture("claude")
  const original = f.kernel.callHost
  let finish: (() => void) | undefined
  f.kernel.callHost = (async (method, params) => {
    if (method === "keychain.set")
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    return original(method, params)
  }) as Kernel["callHost"]
  const saved = f.flow.action(f.bot, { action: "paste", value: token }).catch(() => null)
  await Bun.sleep(0)
  await f.flow.action(f.bot, { action: "cancel" })
  finish?.()
  await saved
  expect(f.vault.size).toBe(0)
  expect(storedProviderLoginSource(f.kernel, f.bot)).toBeNull()
})

test("cancel before shell discovery completes never spawns a CLI", async () => {
  const f = fixture()
  let finish: ((value: Record<string, string>) => void) | undefined
  f.kernel.shellEnv = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  await f.flow.action(f.bot, { action: "start" })
  await f.flow.action(f.bot, { action: "cancel" })
  finish?.({})
  await Bun.sleep(10)
  expect(f.invocations).toHaveLength(0)
})

test("local credential loading redacts individual tokens after a fresh sidecar start", async () => {
  const f = fixture("codex")
  await f.flow.action(f.bot, { action: "paste", value: codex })
  f.redactions.length = 0
  const prepared = await prepareLocalProviderLogin(f.kernel, f.bot, new AbortController().signal)
  expect(f.redactions).toContain("synthetic-access")
  expect(f.redactions).toContain("synthetic-refresh")
  prepared.release()
})

test("Claude token capture joins a token wrapped by the official CLI terminal renderer", async () => {
  const f = fixture("claude", "wrapped")
  await f.flow.action(f.bot, { action: "start" })
  await waitState(f, "ready")
  expect(f.vault.get(providerLoginAccount(f.bot.id, "claude"))).toBe(`${token}synthetic-wrapped-continuation`)
})

for (const mode of ["code-bel", "code-st"])
  test(`Claude detects the paste prompt and the full OSC 8 URL (${mode})`, async () => {
    const f = fixture("claude", mode)
    await f.flow.action(f.bot, { action: "start" })
    expect(await waitView(f, (view) => !!view.needsCode)).toEqual({
      provider: "claude",
      state: "waiting",
      needsCode: true,
      verificationUrl: authorizeUrl,
    })
    expect(f.vault.size).toBe(0)
    const response = await f.flow.action(f.bot, { action: "code", value: `  ${browserCode}  ` })
    expect(JSON.stringify(response)).not.toContain(browserCode)
    await waitState(f, "ready")
    expect(f.vault.get(providerLoginAccount(f.bot.id, "claude"))).toBe(token)
    expect(f.redactions).toContain(browserCode)
    expect(f.kernel.redact(`echoed ${browserCode}`)).toBe("echoed [REDACTED]")
    expect(JSON.stringify(await f.flow.status(f.bot))).not.toContain(browserCode)
  })

for (const url of [
  "http://claude.com/cai/oauth/authorize?state=test",
  "https://claude.com.example/cai/oauth/authorize",
  "https://claude.com/other",
  "https://claude.ai/cai/oauth/authorize",
  "https://user:password@claude.com/cai/oauth/authorize",
])
  test(`Claude rejects an unexpected authorize URL: ${url}`, async () => {
    const f = fixture("claude", "code-bel", 3000, { url })
    await f.flow.action(f.bot, { action: "start" })
    const view = await waitView(f, (view) => !!view.needsCode)
    expect(view.verificationUrl).toBeUndefined()
  })

test("Claude rejects invalid codes before writing to stdin", async () => {
  const f = fixture("claude", "code-bel")
  await expect(f.flow.action(f.bot, { action: "code", value: browserCode })).rejects.toThrow()
  await f.flow.action(f.bot, { action: "start" })
  await waitView(f, (view) => !!view.needsCode)
  await expect(f.flow.action(f.bot, { action: "code" })).rejects.toThrow()
  for (const value of ["", "  ", "x".repeat(2001), "one\ntwo", "one\rtwo", `${browserCode}\n`])
    await expect(f.flow.action(f.bot, { action: "code", value })).rejects.toThrow()
  expect(f.redactions).not.toContain(browserCode)
  await f.flow.action(f.bot, { action: "code", value: browserCode })
  await waitState(f, "ready")
  const other = fixture("codex", "wait")
  await other.flow.action(other.bot, { action: "start" })
  await expect(other.flow.action(other.bot, { action: "code", value: browserCode })).rejects.toThrow()
})

test("Claude reports an invalid code and waits for a fresh paste prompt before retrying", async () => {
  const f = fixture("claude", "code-retry")
  await f.flow.action(f.bot, { action: "start" })
  await waitView(f, (view) => !!view.needsCode)
  await f.flow.action(f.bot, { action: "code", value: "synthetic-wrong-code" })
  const failed = await waitView(f, (view) => !!view.codeError)
  expect(failed.codeError).toContain("Código inválido")
  expect(failed.needsCode).toBe(true)
  expect(JSON.stringify(failed)).not.toContain("synthetic-wrong-code")
  expect(f.redactions).toContain("synthetic-wrong-code")
  expect(f.kernel.redact("echoed synthetic-wrong-code")).toBe("echoed [REDACTED]")
  expect(f.vault.size).toBe(0)
  const retried = await f.flow.action(f.bot, { action: "code", value: browserCode })
  expect(retried.codeError).toBeUndefined()
  expect(JSON.stringify(retried)).not.toContain(browserCode)
  await waitState(f, "ready")
  expect(f.vault.get(providerLoginAccount(f.bot.id, "claude"))).toBe(token)
  expect(f.redactions).toContain(browserCode)
})

test.skipIf(process.platform !== "darwin")(
  "macOS expect bridge delivers code to the CLI TTY and captures its token",
  async () => {
    const f = fixture("claude", "success", 3000, { bridge: true })
    await f.flow.action(f.bot, { action: "start" })
    await waitView(f, (view) => !!view.needsCode)
    expect(f.invocations[0]?.cmd).toBe("/usr/bin/expect")
    await f.flow.action(f.bot, { action: "code", value: browserCode })
    await waitState(f, "ready")
    expect(f.vault.get(providerLoginAccount(f.bot.id, "claude"))).toBe(token)
  },
)

test.skipIf(process.platform !== "darwin")("cancelling the expect bridge kills both expect and its CLI", async () => {
  const f = fixture("claude", "success", 3000, { bridge: true })
  await f.flow.action(f.bot, { action: "start" })
  await waitView(f, (view) => !!view.needsCode)
  const invocation = f.invocations[0]
  if (!invocation) throw new Error("Missing expect invocation")
  const pid = Number(readFileSync(join(invocation.cwd, "cli.pid"), "utf8").trim())
  await f.flow.action(f.bot, { action: "cancel" })
  await f.children[0]?.exited
  // The CLI is in a separate process group and can be reaped after expect exits.
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      process.kill(pid, 0)
    } catch {
      break
    }
    await Bun.sleep(10)
  }
  expect(() => process.kill(pid, 0)).toThrow()
  expect(f.vault.size).toBe(0)
  expect(f.kills).toContain("SIGKILL")
})

for (const event of ["deleted", "provider-changed", "cloud"])
  test(`${event} stops an ongoing login CLI`, async () => {
    const f = fixture("codex", "wait")
    await f.flow.action(f.bot, { action: "start" })
    for (let attempt = 0; !f.invocations.length && attempt < 100; attempt++) await Bun.sleep(10)
    f.emit(
      event === "deleted"
        ? { type: "bot.deleted", botId: f.bot.id }
        : {
            type: "bot.updated",
            bot: { ...f.bot, ...(event === "cloud" ? { machine: "cloud" as const } : { provider: "claude" as const }) },
          },
    )
    expect(f.kills).toContain("SIGKILL")
    expect(f.vault.size).toBe(0)
  })

for (const provider of ["claude", "codex", "opencode"] as const)
  test(`${provider}: local turn consumes vault login and removes temporary credentials`, async () => {
    const f = fixture(provider)
    const value = provider === "claude" ? token : provider === "codex" ? codex : openCode
    await f.flow.action(f.bot, { action: "paste", value })
    const prepared = await prepareLocalProviderLogin(f.kernel, f.bot, new AbortController().signal)
    if (provider === "claude") expect(prepared.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(token)
    else {
      const directory = provider === "codex" ? prepared.env.CODEX_HOME : prepared.env.XDG_DATA_HOME
      const path = join(directory ?? "", provider === "codex" ? "auth.json" : "opencode/auth.json")
      expect(readFileSync(path, "utf8")).toBe(value)
      prepared.release()
      expect(existsSync(path)).toBe(false)
    }
  })

for (const provider of ["codex", "claude", "opencode"] as const)
  test(`${provider}: readiness separates installation from saved login and never starts a provider`, async () => {
    const f = fixture(provider, "success", 3000, { platform: "linux", headless: true })
    const draftId = "draft-00000000-0000-4000-8000-000000000000"
    const directory = provider === "claude" ? ".claude" : provider === "codex" ? ".codex" : ".local/share/opencode"
    const filename = provider === "claude" ? ".credentials.json" : "auth.json"
    mkdirSync(join(f.root, directory), { recursive: true })
    writeFileSync(
      join(f.root, directory, filename),
      provider === "claude"
        ? JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 60_000 } })
        : provider === "codex"
          ? codex
          : openCode,
    )
    // A unique configured basename keeps host-installed CLIs out of this fixture.
    const binary = join(f.root, "fake bin", `readiness-fixture-${provider}`)
    const variable = `TOURI_${provider.toUpperCase()}_BIN`
    const previous = process.env[variable]
    process.env[variable] = binary
    cleanups.push(() => {
      if (previous === undefined) delete process.env[variable]
      else process.env[variable] = previous
    })
    const request = {
      params: { id: draftId },
      query: { provider },
      body: { provider, action: "use-host" },
      signal: new AbortController().signal,
    }
    const get = f.flow.routes.find((route) => route.method === "GET")
    const post = f.flow.routes.find((route) => route.method === "POST")
    if (!get || !post) throw new Error("Missing login routes")
    expect(await get.handler(request)).toMatchObject({
      status: 200,
      json: {
        state: "host-available",
        executable: "missing",
        host: "server",
      },
    })
    expect(await post.handler(request)).toMatchObject({ json: { executable: "missing" } })
    expect((await f.flow.status({ ...f.bot, id: draftId })).state).toBe("host-available")
    expect(f.invocations).toHaveLength(0)
    // A present but non-executable file is also missing.
    writeFileSync(binary, "#!/bin/sh\nexit 93\n", { mode: 0o600 })
    expect(await get.handler(request)).toMatchObject({ json: { executable: "missing" } })
    rmSync(binary)
    // Recheck notices installation without running even --version or an inference request.
    writeFileSync(binary, "#!/bin/sh\nexit 93\n", { mode: 0o700 })
    expect(await get.handler(request)).toMatchObject({ json: { executable: "available", state: "host-available" } })
    expect(await post.handler(request)).toMatchObject({ json: { executable: "available", state: "ready" } })
    expect(f.invocations).toHaveLength(0)
  })

for (const provider of ["claude", "codex"] as const)
  for (const terminal of ["cancelled", "error"] as const)
    test(`${provider}: ${terminal} login rechecks a saved VM credential without starting another CLI`, async () => {
      const f = fixture(provider, terminal === "error" ? "fail" : "wait")
      f.bot.machine = "vm"
      // Keep shell discovery pending until cancellation, or let the CLI fail.
      await f.flow.action(f.bot, { action: "start" })
      if (terminal === "error") await waitState(f, "error")
      else await f.flow.action(f.bot, { action: "cancel" })
      expect((await f.flow.status(f.bot)).state).toBe(terminal)
      f.vault.set(providerLoginAccount(f.bot.id, provider), provider === "claude" ? token : codex)
      const before = f.invocations.length
      expect(await f.flow.status(f.bot)).toEqual({ provider, state: "ready" })
      expect(await f.flow.status(f.bot)).toEqual({ provider, state: "ready" })
      expect(f.invocations).toHaveLength(before)
      expect(storedProviderLoginSource(f.kernel, f.bot)).toBe("vault")
    })

test("a temporary vault failure recovers through status without launching login", async () => {
  const f = fixture("claude", "success", 3000, { platform: "darwin", headless: false })
  f.vault.set(providerLoginAccount(f.bot.id, "claude"), token)
  const callHost = f.kernel.callHost
  f.kernel.callHost = async () => ({ success: false, errorCode: "HOST_ERROR", error: "unavailable" })
  expect(await f.flow.status(f.bot)).toMatchObject({ state: "vault-locked" })
  f.kernel.callHost = callHost
  expect(await f.flow.status(f.bot)).toEqual({ provider: "claude", state: "ready" })
  expect(f.invocations).toHaveLength(0)
})
