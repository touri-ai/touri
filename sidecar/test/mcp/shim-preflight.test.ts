import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseMcpShimStage } from "../../src/mcp/startup-stage"

// Exercise the public CLI too: the desktop entry alone would miss data-dir regressions.
test.each([
  { name: "missing token", token: null, endpoint: "missing.sock", stage: "token_unavailable" },
  { name: "unreadable token", token: "directory", endpoint: "missing.sock", stage: "token_unavailable" },
  { name: "empty token", token: "", endpoint: "missing.sock", stage: "token_unavailable" },
  { name: "missing socket", token: "fixture-token", endpoint: "missing.sock", stage: "socket_error" },
  { name: "invalid endpoint", token: "fixture-token", endpoint: "tcp://192.0.2.1:1234", stage: "socket_error" },
])("$name emits a classified failure without disclosing a local path", async ({ token, endpoint, stage }) => {
  const root = mkdtempSync(join(tmpdir(), "touri-shim-preflight-"))
  const tokenPath = join(root, "run/mcp-tokens/missing-thread")
  mkdirSync(join(root, "run/mcp-tokens"), { recursive: true, mode: 0o700 })
  if (token === "directory") mkdirSync(tokenPath)
  else if (token !== null) writeFileSync(tokenPath, token, { mode: 0o600 })
  const binary = process.env.TOURI_TEST_SHIM_BIN
  const child = Bun.spawn({
    cmd: binary
      ? [binary, "mcp-stdio", "--thread", "missing-thread"]
      : [
          process.execPath,
          "run",
          join(import.meta.dir, "../../src/cli/main.ts"),
          "mcp-stdio",
          "--thread",
          "missing-thread",
        ],
    env: {
      ...process.env,
      TOURI_APP_DATA: root,
      TOURI_MCP_SOCK: endpoint.startsWith("tcp:") ? endpoint : join(root, endpoint),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code).toBe(1)
    expect(stdout).toBe("")
    expect(parseMcpShimStage(stderr)).toBe(stage)
    expect(stderr).not.toContain(root)
    expect(stderr.trim()).toBe(`touri MCP startup failed: ${stage}`)
  } finally {
    child.kill()
    await child.exited
    rmSync(root, { recursive: true, force: true })
  }
})

test("legacy shim and provider diagnostics retain their known startup stages", () => {
  expect(parseMcpShimStage("Unable to read MCP token: ENOENT")).toBe("token_unavailable")
  expect(parseMcpShimStage("MCP socket error: connect ECONNREFUSED")).toBe("socket_error")
  expect(parseMcpShimStage(JSON.stringify({ failed: [{ server: "touri", error: "initialize closed" }] }))).toBe(
    "closed_before_initialize",
  )
})

test.each([
  { id: 0, token: false, stage: "token_unavailable" },
  { id: "init-request", token: false, stage: "token_unavailable" },
  { id: 0, token: true, stage: "socket_error" },
])(
  "a provider receives $stage through initialize response $id even if it drops stderr",
  async ({ id, token, stage }) => {
    const root = mkdtempSync(join(tmpdir(), "touri-shim-initialize-"))
    if (token) {
      mkdirSync(join(root, "run/mcp-tokens"), { recursive: true, mode: 0o700 })
      writeFileSync(join(root, "run/mcp-tokens/missing"), "fixture-token", { mode: 0o600 })
    }
    const binary = process.env.TOURI_TEST_SHIM_BIN
    const child = Bun.spawn({
      cmd: binary
        ? [binary, "mcp-stdio", "--thread", "missing"]
        : [process.execPath, "run", join(import.meta.dir, "../../src/cli/main.ts"), "mcp-stdio", "--thread", "missing"],
      env: { ...process.env, TOURI_APP_DATA: root },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    })
    try {
      const request = JSON.stringify({ jsonrpc: "2.0", id, method: "initialize", params: {} })
      child.stdin.write(request.slice(0, 15))
      await Bun.sleep(10)
      child.stdin.write(`${request.slice(15)}\n`)
      const output = await new Response(child.stdout).text()
      expect(await child.exited).toBe(1)
      const reply = JSON.parse(output)
      expect(reply).toEqual({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: `touri MCP startup failed: ${stage}` },
      })
      expect(parseMcpShimStage(reply.error.message)).toBe(stage)
    } finally {
      child.kill()
      await child.exited
      rmSync(root, { recursive: true, force: true })
    }
  },
)
