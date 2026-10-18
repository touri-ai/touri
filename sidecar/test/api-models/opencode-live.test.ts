import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ApiModel,
  type Bot,
  getApiModelReference,
  type Kernel,
  type ProviderEvent,
  type ProviderSession,
  type StartTurnArgs,
  type Thread,
} from "@touri/contracts"
import { getApiModelAccount, saveApiModel } from "../../src/api-models/config"
import { createKernel } from "../../src/kernel"
import { buildChildEnv } from "../../src/kernel/shell-env"
import { createOpenCodeAdapter } from "../../src/runtime/opencode/adapter"
import { openCodeBinary } from "../../src/runtime/opencode/config"

const cleanups = new Set<() => Promise<void> | void>()
afterEach(async () => {
  for (const close of cleanups) await close()
  cleanups.clear()
})

const binary = openCodeBinary(buildChildEnv({ base: process.env }))
const getFiles = (root: string): string[] =>
  readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return getFiles(path)
    if (entry.isFile()) return [path]
    return []
  })

test.skipIf(!binary.success)(
  "the installed executor completes a real API turn without writing the API key to disk",
  async () => {
    if (!binary.success) return
    const root = mkdtempSync(join(tmpdir(), "touri-api-live-"))
    const runtime = createKernel({ appData: root })
    const key = "fixture-live-api-key"
    const seen = new Set<string>()
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        seen.add(request.headers.get("Authorization") ?? "")
        if (request.headers.get("Authorization") !== `Bearer ${key}`) return new Response(null, { status: 401 })
        if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response(null, { status: 404 })
        const body = (await request.json()) as { model: string; stream?: boolean }
        expect(body.model).toBe("test-model")
        if (JSON.stringify(body).includes("fixture-reject-key"))
          return Response.json(
            { error: { message: `Invalid API key: ${key}`, code: "invalid_api_key" } },
            { status: 401 },
          )
        if (!body.stream)
          return Response.json({
            id: "completion-test",
            choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
          })
        const chunks = [
          {
            id: "completion-test",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }],
          },
          {
            id: "completion-test",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
        ]
        return new Response(
          chunks
            .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
            .join("")
            .concat("data: [DONE]\n\n"),
          { headers: { "Content-Type": "text/event-stream" } },
        )
      },
    })
    const model: ApiModel = {
      id: "live",
      preset: "custom",
      name: "Teste local",
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      modelId: "test-model",
    }
    saveApiModel(runtime.kernel, model)
    const callHost = (async (method: string, input: { account: string }) => {
      expect(method).toBe("keychain.get")
      expect(input.account).toBe(getApiModelAccount(model.id))
      return { success: true, value: { value: key } }
    }) as Kernel["callHost"]
    const kernel = Object.assign({}, runtime.kernel, { callHost })
    const adapter = createOpenCodeAdapter({ kernel, command: binary.path })
    cleanups.add(() => adapter.shutdown())
    cleanups.add(() => {
      server.stop(true)
    })
    cleanups.add(() => {
      runtime.stop()
      rmSync(root, { recursive: true, force: true })
    })
    const events = new Set<ProviderEvent>()
    const args: StartTurnArgs = {
      bot: {
        id: "api-bot",
        machine: "local",
        provider: "opencode",
        model: getApiModelReference(model),
        homeDir: join(root, "bots/api-bot"),
        projectId: null,
        access: "full",
        approvals: "never",
        reasoningEffort: null,
      } as Bot,
      thread: { id: "api-thread", title: "Teste" } as Thread,
      session: null,
      fingerprint: { cwd: root } as StartTurnArgs["fingerprint"],
      developerInstructions: "Reply OK.",
      handoffPacket: null,
      input: [{ type: "text", text: "Hello" }],
      mcp: { command: "unused", args: [], env: {} },
      env: { HOME: root },
      conversationOnly: true,
      signal: AbortSignal.timeout(60_000),
      onEvent: (event) => {
        events.add(event)
      },
    }
    const result = await adapter.startTurn(args)
    expect(result).toMatchObject({ success: true, status: "succeeded" })
    expect(seen.has(`Bearer ${key}`)).toBe(true)
    expect(Array.from(events).some((event) => event.type === "text_delta" && event.delta.includes("OK"))).toBe(true)
    if (!result.success || !result.externalSessionId) throw new Error("The local API fixture did not create a session")
    const session = { externalSessionId: result.externalSessionId } as ProviderSession

    const resumed = await adapter.startTurn(Object.assign({}, args, { session }))

    expect(resumed).toMatchObject({ success: true, status: "succeeded", externalSessionId: result.externalSessionId })

    const rejected = await adapter.startTurn(
      Object.assign({}, args, { session, input: [{ type: "text", text: "fixture-reject-key" }] }),
    )

    expect(rejected).toMatchObject({ success: false, errorCode: "cli_auth" })
    expect(JSON.stringify(rejected)).not.toContain(key)
    await adapter.shutdown()
    const leaked = getFiles(root).filter((file) => readFileSync(file).includes(Buffer.from(key)))
    expect(leaked.map((file) => file.slice(root.length))).toEqual([])
  },
  90_000,
)
