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

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
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
  const kernel = { db, paths: { appData, runDir: join(appData, "run") } } as Kernel
  const prepare = () => prepareLocalProviderLogin(kernel, bot, new AbortController().signal, host)
  cleanups.push(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, host, appData, bot, db, kernel, auth, prepare }
}

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
    prepared.release()
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
