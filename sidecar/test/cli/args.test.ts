import { expect, test } from "bun:test"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { expandHome, parseCli } from "../../src/cli/args"
import { remoteAccessWarning } from "../../src/cli/remoteAccessWarning"
import { DEPRECATED_IMPORT_ALIAS } from "../../src/importer/deprecatedAliases"

test("serve defaults to loopback 8795 with ~/.touri and pairing on", () => {
  const parsed = parseCli(["serve"])
  expect(parsed).toEqual({
    success: true,
    command: {
      name: "serve",
      options: {
        port: 8795,
        drainTimeoutMs: 60_000,
        host: "127.0.0.1",
        dataDir: join(homedir(), ".touri"),
        tailscale: false,
        noPair: false,
        uiDir: null,
      },
    },
  })
})

test("serve accepts every flag, both as separate values and key=value", () => {
  const parsed = parseCli([
    "serve",
    "--port",
    "9000",
    "--drain-timeout=45",
    "--host=0.0.0.0",
    "--data-dir",
    "/srv/t",
    "--tailscale",
    "--no-pair",
  ])
  expect(parsed.success && parsed.command.name === "serve" && parsed.command.options).toEqual({
    port: 9000,
    drainTimeoutMs: 45_000,
    host: "0.0.0.0",
    dataDir: "/srv/t",
    tailscale: true,
    noPair: true,
    uiDir: null,
  })
})

test("rejects bad ports, unknown options and missing values", () => {
  expect(parseCli(["serve", "--port", "70000"]).success).toBe(false)
  expect(parseCli(["serve", "--port", "abc"]).success).toBe(false)
  expect(parseCli(["serve", "--drain-timeout", "0"]).success).toBe(false)
  expect(parseCli(["serve", "--drain-timeout", "601"]).success).toBe(false)
  expect(parseCli(["serve", "--drain-timeout", "1.5"]).success).toBe(false)
  expect(parseCli(["serve", "--bogus"])).toEqual({ success: false, error: "Unknown option --bogus" })
  expect(parseCli(["serve", "--port"])).toEqual({ success: false, error: "Option --port needs a value" })
  expect(parseCli(["nope"])).toEqual({ success: false, error: "Unknown command nope" })
})

test("pair, pair --client, status, doctor and devices parse", () => {
  expect(parseCli(["pair"])).toMatchObject({ success: true, command: { name: "pair", client: false } })
  expect(parseCli(["pair", "--client", "--url", "https://x:8445", "--code", "ABCD-EFGH-JKMN"])).toMatchObject({
    command: { name: "pair", client: true, url: "https://x:8445", code: "ABCD-EFGH-JKMN" },
  })
  expect(parseCli(["status"])).toMatchObject({ command: { name: "status" } })
  expect(parseCli(["doctor"])).toMatchObject({ command: { name: "doctor" } })
  expect(parseCli(["devices", "revoke", "abc123"])).toMatchObject({ command: { name: "devices", revokeId: "abc123" } })
  expect(parseCli(["devices", "revoke"]).success).toBe(false)
})

test("pair --client --print-token requests token-only output and requires client pairing", () => {
  expect(
    parseCli(["pair", "--client", "--print-token", "--url", "https://box.example", "--code", "ABCD-EFGH-JKMN"]),
  ).toMatchObject({
    success: true,
    command: { name: "pair", client: true, printToken: true, url: "https://box.example", code: "ABCD-EFGH-JKMN" },
  })
  expect(parseCli(["pair", "--print-token"])).toEqual({ success: false, error: "--print-token requires pair --client" })
})

test("import legacy needs --path and understands --dry-run", () => {
  expect(parseCli(["import", "legacy"]).success).toBe(false)
  expect(parseCli(["import", "other", "--path", "/x"]).success).toBe(false)
  expect(parseCli(["import", "legacy", "--path", "~/.legacy-app", "--dry-run"])).toMatchObject({
    success: true,
    command: { name: "import-legacy", path: join(homedir(), ".legacy-app"), dryRun: true, importCodexSessions: false },
  })
})

test("the deprecated importer name still parses as import legacy", () => {
  expect(parseCli(["import", DEPRECATED_IMPORT_ALIAS, "--path", "/x"])).toMatchObject({
    success: true,
    command: { name: "import-legacy", path: "/x", dryRun: false },
  })
  expect(parseCli(["--help"])).toMatchObject({ command: { name: "help" } })
})

test("mcp-stdio, version and help", () => {
  expect(parseCli(["mcp-stdio", "--thread", "t1"])).toMatchObject({ command: { name: "mcp-stdio", threadId: "t1" } })
  expect(parseCli(["mcp-stdio"]).success).toBe(false)
  expect(parseCli(["mcp-stdio", "--thread", "t1"], { TOURI_APP_DATA: "/srv/touri" })).toMatchObject({
    command: { name: "mcp-stdio", threadId: "t1", dataDir: "/srv/touri" },
  })
  expect(parseCli(["mcp-stdio", "--thread", "t1", "--data-dir", "/x"], { TOURI_APP_DATA: "/srv/touri" })).toMatchObject(
    {
      command: { dataDir: "/x" },
    },
  )
  expect(parseCli(["serve", "--data-dir", "./data"])).toMatchObject({
    command: { options: { dataDir: resolve("data") } },
  })
  expect(parseCli(["mcp-stdio", "--thread", "t1", "--data-dir", "./data"])).toMatchObject({
    command: { dataDir: resolve("data") },
  })
  expect(parseCli(["--version"])).toEqual({ success: true, command: { name: "version" } })
  expect(parseCli([])).toEqual({ success: true, command: { name: "help" } })
  expect(parseCli(["serve", "--help"])).toEqual({ success: true, command: { name: "help" } })
})

test("expandHome only touches a leading tilde", () => {
  expect(expandHome("~/x", "/h")).toBe("/h/x")
  expect(expandHome("~", "/h")).toBe("/h")
  expect(expandHome("/a/~/b", "/h")).toBe("/a/~/b")
})

test("R11-REG-08: binding beyond loopback without an HTTPS proxy warns the operator", () => {
  expect(remoteAccessWarning({ host: "0.0.0.0", proxied: false })).toContain("HTTP 426")
  expect(remoteAccessWarning({ host: "192.168.7.5", proxied: false })).toContain("--trust-proxy")
  expect(remoteAccessWarning({ host: "127.0.0.1", proxied: false })).toBeNull()
  expect(remoteAccessWarning({ host: "localhost", proxied: false })).toBeNull()
  expect(remoteAccessWarning({ host: "127.0.0.1", proxied: true })).toBeNull()
})
