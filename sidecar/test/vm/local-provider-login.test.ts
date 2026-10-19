import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Kernel } from "@touri/contracts"
import { prepareLocalProviderLogin } from "../../src/vm/local-provider-login"
import { providerLoginSourceKey } from "../../src/vm/provider-login"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "touri-local-login-"))
  const host = join(root, "host")
  const appData = join(root, "data")
  const bot = { id: "bot-login", provider: "codex", machine: "local", homeDir: join(appData, "bots/bot-login") } as Bot
  const db = new Database(":memory:")
  db.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT, updated_at INTEGER)")
  mkdirSync(join(host, ".codex/sessions"), { recursive: true })
  mkdirSync(join(appData, "run"), { recursive: true })
  const auth = join(host, ".codex/auth.json")
  writeFileSync(auth, '{"tokens":{"access_token":"synthetic-access"}}')
  const kernel = {
    db,
    paths: { appData, runDir: join(appData, "run") },
    callHost: async () => ({ success: true, value: { value: '{"tokens":{"access_token":"synthetic-vault"}}' } }),
    addRedactionValue: () => {},
  } as unknown as Kernel
  const prepare = () => prepareLocalProviderLogin(kernel, bot, new AbortController().signal, host)
  cleanups.push(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, host, appData, bot, db, kernel, auth, prepare }
}

test("local Codex vault login preserves its home and rollouts after releasing credentials", async () => {
  const f = fixture()
  f.db.query("INSERT INTO settings VALUES (?, ?, 1)").run(providerLoginSourceKey(f.bot), '"vault"')
  const prepared = await f.prepare()
  cleanups.unshift(prepared.release)
  const home = prepared.env.CODEX_HOME ?? ""
  const auth = join(home, "auth.json")
  expect(home).toBe(join(f.appData, "provider-homes/codex-vault", f.bot.id))
  expect(lstatSync(auth).isSymbolicLink()).toBe(false)
  expect(statSync(auth).mode & 0o777).toBe(0o600)
  expect(statSync(home).mode & 0o777).toBe(0o700)
  expect(Bun.TOML.parse(readFileSync(join(home, "config.toml"), "utf8"))).toEqual({
    cli_auth_credentials_store: "file",
  })
  mkdirSync(join(home, "sessions"))
  const rollout = join(home, "sessions/turn.jsonl")
  writeFileSync(rollout, "synthetic session")
  // Native session indexes belong to the durable home as well as the rollout files.
  writeFileSync(join(home, "session-index.sqlite"), "synthetic index")
  await prepared.release()
  expect(existsSync(auth)).toBe(false)
  expect(readFileSync(rollout, "utf8")).toBe("synthetic session")

  const restarted = await prepareLocalProviderLogin({ ...f.kernel }, f.bot, new AbortController().signal, f.host)
  cleanups.unshift(restarted.release)
  expect(restarted.env.CODEX_HOME).toBe(home)
  expect(readFileSync(rollout, "utf8")).toBe("synthetic session")
  expect(readFileSync(join(home, "session-index.sqlite"), "utf8")).toBe("synthetic index")
  expect(readFileSync(auth, "utf8")).toContain("synthetic-vault")
  await restarted.release()
  expect(existsSync(auth)).toBe(false)
})

test("overlapping local Codex turns keep vault credentials until the final release", async () => {
  const f = fixture()
  f.db.query("INSERT INTO settings VALUES (?, ?, 1)").run(providerLoginSourceKey(f.bot), '"vault"')
  const [first, second] = await Promise.all([f.prepare(), f.prepare()])
  cleanups.unshift(first.release, second.release)
  const auth = join(first.env.CODEX_HOME ?? "", "auth.json")
  expect(second.env.CODEX_HOME).toBe(first.env.CODEX_HOME)
  await first.release()
  await first.release()
  expect(readFileSync(auth, "utf8")).toContain("synthetic-vault")
  await second.release()
  expect(existsSync(auth)).toBe(false)
})

test("switching local Codex to vault login leaves the host authentication link untouched", async () => {
  const f = fixture()
  const host = await f.prepare()
  const hostAuth = join(host.env.CODEX_HOME ?? "", "auth.json")
  f.db.query("INSERT INTO settings VALUES (?, ?, 1)").run(providerLoginSourceKey(f.bot), '"vault"')
  const vault = await f.prepare()
  cleanups.unshift(vault.release)
  expect(vault.env.CODEX_HOME).not.toBe(host.env.CODEX_HOME)
  expect(readlinkSync(hostAuth)).toBe(f.auth)
  expect(readFileSync(f.auth, "utf8")).toContain("synthetic-access")
  expect(readFileSync(join(vault.env.CODEX_HOME ?? "", "auth.json"), "utf8")).toContain("synthetic-vault")
  await vault.release()
  expect(readlinkSync(hostAuth)).toBe(f.auth)
  expect(readFileSync(hostAuth, "utf8")).toContain("synthetic-access")
})

for (const selected of [false, true])
  test(`local Codex isolates ${selected ? "selected" : "legacy"} host login and shares refreshes`, async () => {
    const f = fixture()
    if (selected) f.db.query("INSERT INTO settings VALUES (?, ?, 1)").run(providerLoginSourceKey(f.bot), '"host-file"')
    const prepared = await f.prepare()
    const home = prepared.env.CODEX_HOME ?? ""
    expect(home).toBe(join(f.appData, "provider-homes/codex", f.bot.id))
    expect(lstatSync(join(home, "auth.json")).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(home, "auth.json"))).toBe(f.auth)
    expect(statSync(home).mode & 0o777).toBe(0o700)
    expect(existsSync(join(home, "sessions"))).toBe(false)
    // Both the CLI refresh and a later host login remain visible through the link.
    writeFileSync(join(home, "auth.json"), '{"tokens":{"access_token":"refreshed"}}')
    expect(readFileSync(f.auth, "utf8")).toContain("refreshed")
    rmSync(f.auth)
    writeFileSync(f.auth, '{"tokens":{"access_token":"host-refresh"}}')
    expect(readFileSync(join(home, "auth.json"), "utf8")).toContain("host-refresh")
    mkdirSync(join(home, "sessions"))
    writeFileSync(join(home, "sessions/turn.jsonl"), "synthetic session")
    await prepared.release()
    expect(existsSync(home)).toBe(true)
    await f.prepare()
    expect(readFileSync(join(home, "sessions/turn.jsonl"), "utf8")).toBe("synthetic session")
    f.bot.id = "other-bot"
    expect((await f.prepare()).env.CODEX_HOME).not.toBe(home)
  })

test("managed Codex config preserves auth and provider settings without host behavior", async () => {
  const f = fixture()
  const config = `model_provider = "custom"
model = "custom-model"
preferred_auth_method = "chatgpt"
cli_auth_credentials_store = "keyring"
notify = ["unsafe-notify"]
history = { persistence = "save-all" }
[projects."/fixture/project"]
trust_level = "trusted"
[hooks]
command = "unsafe-hook"
[mcp_servers.other]
command = "unsafe-server"
[model_providers.custom]
name = "Custom provider"
base_url = "https://provider.invalid/v1"
env_key = "CUSTOM_API_KEY"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "synthetic-provider-token"
auth = { command = "unsafe-credential-command" }
http_headers = { "x-custom" = "test-value" }
env_http_headers = { "x-token" = "CUSTOM_TOKEN" }
query_params = { "api-version" = "test-version" }
`
  const source = join(f.host, ".codex/config.toml")
  writeFileSync(source, config)
  const prepared = await f.prepare()
  const target = join(prepared.env.CODEX_HOME ?? "", "config.toml")
  const parsed = Bun.TOML.parse(readFileSync(target, "utf8"))
  expect(parsed).toEqual({
    model_provider: "custom",
    model: "custom-model",
    preferred_auth_method: "chatgpt",
    cli_auth_credentials_store: "file",
    model_providers: {
      custom: {
        name: "Custom provider",
        base_url: "https://provider.invalid/v1",
        env_key: "CUSTOM_API_KEY",
        wire_api: "responses",
        requires_openai_auth: false,
        experimental_bearer_token: "synthetic-provider-token",
        http_headers: { "x-custom": "test-value" },
        env_http_headers: { "x-token": "CUSTOM_TOKEN" },
        query_params: { "api-version": "test-version" },
      },
    },
  })
  expect(statSync(target).mode & 0o777).toBe(0o600)
  expect(lstatSync(target).isSymbolicLink()).toBe(false)
  expect(readFileSync(source, "utf8")).toBe(config)
  writeFileSync(source, 'model_provider = "openai"\n')
  await f.prepare()
  expect(Bun.TOML.parse(readFileSync(target, "utf8"))).toEqual({
    model_provider: "openai",
    cli_auth_credentials_store: "file",
  })
})

test("a linked host config is read as data without linking it into the managed home", async () => {
  const f = fixture()
  const source = join(f.root, "config.toml")
  writeFileSync(source, 'model_provider = "custom"\n')
  symlinkSync(source, join(f.host, ".codex/config.toml"))
  const prepared = await f.prepare()
  const config = join(prepared.env.CODEX_HOME ?? "", "config.toml")
  expect(lstatSync(config).isSymbolicLink()).toBe(false)
  expect(Bun.TOML.parse(readFileSync(config, "utf8"))).toEqual({
    model_provider: "custom",
    cli_auth_credentials_store: "file",
  })
})

for (const provider of ["claude", "opencode"] as const)
  test(`${provider} host login keeps its existing home and macOS credential identity`, async () => {
    const f = fixture()
    f.bot.provider = provider
    expect((await f.prepare()).env).toEqual({})
  })

test("Codex profiles and remote bots keep their existing provider homes", async () => {
  const f = fixture()
  f.bot.providerProfile = "work"
  expect((await f.prepare()).env).toEqual({})
  f.bot.providerProfile = null
  for (const machine of ["vm", "cloud"] as const) {
    f.bot.machine = machine
    expect((await f.prepare()).env).toEqual({})
  }
})
