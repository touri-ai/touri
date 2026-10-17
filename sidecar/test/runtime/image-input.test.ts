import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Kernel, StartTurnArgs, Thread } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { claudeUserContent } from "../../src/runtime/claude/claudeUserContent"
import { createCodexAdapter } from "../../src/runtime/codex/adapter"
import { codexInputItems } from "../../src/runtime/codex/codexInputItems"

const PNG = Buffer.from("89504e470d0a1a0a00000000", "hex")
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})

const fixture = (input: StartTurnArgs["input"], attachment = true) => {
  const root = mkdtempSync(join(tmpdir(), "touri-image-input-"))
  const runtime = createKernel({ appData: join(root, "data") })
  const attachments = runtime.kernel.paths.attachmentsDir
  mkdirSync(attachments, { recursive: true })
  const path = join(attachments, "shot.png")
  if (attachment) writeFileSync(path, PNG)
  const db = runtime.kernel.db as import("bun:sqlite").Database
  db.query("INSERT INTO attachments(id,path,mime,bytes,created_at) VALUES (?,?,?,?,1)").run(
    "img",
    path,
    "image/png",
    PNG.length,
  )
  const requestLog = join(root, "requests.log")
  const scenario = join(root, "scenario.json")
  writeFileSync(scenario, JSON.stringify({ requestLogPath: requestLog, events: [{ type: "complete" }] }))
  const spawn: Kernel["spawnTree"] = (spawnInput) =>
    runtime.kernel.spawnTree({
      ...spawnInput,
      cmd: process.execPath,
      env: { ...spawnInput.env, TOURI_FAKE_SCENARIO: scenario },
      args: [
        "run",
        join(import.meta.dir, "../fakes/fake-codex.ts"),
        ...(spawnInput.cmd === "/usr/bin/sandbox-exec"
          ? spawnInput.args.slice(3)
          : /\/bwrap$/.test(spawnInput.cmd)
            ? spawnInput.args.slice(spawnInput.args.indexOf("--") + 2)
            : spawnInput.args),
      ],
    })
  const adapter = createCodexAdapter({ kernel: { ...runtime.kernel, spawnTree: spawn }, command: process.execPath })
  const args: StartTurnArgs = {
    bot: {
      provider: "codex",
      access: "full",
      approvals: "on-request",
      homeDir: root,
      model: null,
      reasoningEffort: null,
    } as Bot,
    thread: { id: "thread-image" } as Thread,
    session: null,
    fingerprint: { cwd: root } as StartTurnArgs["fingerprint"],
    input,
    developerInstructions: "Test images.",
    handoffPacket: null,
    mcp: { command: process.execPath, args: [], env: {} },
    env: { HOME: root, TOURI_FAKE_SCENARIO: scenario },
    signal: new AbortController().signal,
    onEvent: () => undefined,
  }
  cleanups.push(() => {
    void adapter.shutdown()
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    adapter,
    args,
    requests: () =>
      readFileSync(requestLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  }
}

const IMAGE_INPUT: StartTurnArgs["input"] = [
  { type: "text", text: "descreva" },
  { type: "image", attachmentId: "img", mime: "image/png" },
]

test("Codex receives an attached image as a data-URL image item, never an attachment id", async () => {
  const f = fixture(IMAGE_INPUT)
  expect(await f.adapter.startTurn(f.args)).toMatchObject({ success: true, status: "succeeded" })
  const items = f.requests().find((frame) => frame.method === "turn/start").params.input
  expect(items[0]).toEqual({ type: "text", text: "descreva" })
  expect(items[1]).toEqual({ type: "image", url: `data:image/png;base64,${PNG.toString("base64")}` })
  expect(JSON.stringify(items)).not.toContain("attachmentId")
})

test("Codex keeps the image when a handoff packet is prepended", async () => {
  const f = fixture(IMAGE_INPUT)
  f.args.handoffPacket = "resumo anterior"
  expect((await f.adapter.startTurn(f.args)).success).toBe(true)
  const items = f.requests().find((frame) => frame.method === "turn/start").params.input
  expect(items[0].text).toContain("resumo anterior")
  expect(items[0].text).toContain("descreva")
  expect(items[1].type).toBe("image")
})

test("the legacy attachmentId item is rejected by the strict app-server fake and classified as a protocol error", async () => {
  const f = fixture(IMAGE_INPUT)
  const legacy = [{ type: "image", attachmentId: "img", mime: "image/png" }]
  const proc = Bun.spawn([process.execPath, "run", join(import.meta.dir, "../fakes/fake-codex.ts")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TOURI_FAKE_SCENARIO: "" },
  })
  proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "turn/start", params: { input: legacy } })}\n`)
  proc.stdin.end()
  const out = await new Response(proc.stdout).text()
  expect(out).toContain("did not match any variant of untagged enum ImageReference")
  expect(f.adapter.provider).toBe("codex")
})

test("a missing attachment fails the turn with a specific message before spawning the provider", async () => {
  const f = fixture(IMAGE_INPUT, false)
  expect(await f.adapter.startTurn(f.args)).toMatchObject({
    success: false,
    errorCode: "tool_error",
    error: expect.stringContaining("imagem anexada"),
  })
})

test("pure builders produce the accepted shapes", () => {
  const image = { attachmentId: "img", mime: "image/png", base64: "QUJD" }
  expect(codexInputItems({ input: [{ type: "text", text: "a" }], images: [image] })).toEqual([
    { type: "text", text: "a" },
    { type: "image", url: "data:image/png;base64,QUJD" },
  ])
  expect(claudeUserContent({ text: "a", images: [image] })).toEqual([
    { type: "text", text: "a" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
  ])
})
