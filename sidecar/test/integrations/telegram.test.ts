import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Kernel, NotificationRecord, Routine, RoutineRun, Run, TelegramIntegration } from "@touri/contracts"
import { createFakeTelegram } from "../../../test/fakes/fake-telegram"
import { createTelegramIntegrations } from "../../src/integrations/telegram"
import { createTelegramApi } from "../../src/integrations/telegram/api"
import { createTelegramBridge } from "../../src/integrations/telegram/bridge"
import { createTelegramStore, tokenAccount } from "../../src/integrations/telegram/store"
import { splitMessage } from "../../src/integrations/telegram/text"
import { createKernel } from "../../src/kernel"
import { createRuntimeEngine } from "../../src/runtime/engine"
import { createRuntimePersistence } from "../../src/runtime/persistence"
import { init as initStore } from "../../src/store"

const TOKEN = "123456789:AAExampleTokenForTouriTests_123456"
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.()
})

const until = async (check: () => boolean, label = "condition") => {
  for (let i = 0; i < 400; i++) {
    if (check()) return
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

const fixture = async ({ token = TOKEN }: { token?: string } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "touri-telegram-"))
  const runtime = createKernel({ appData: root })
  const kernel = runtime.kernel
  const vault = new Map<string, string>()
  const host = kernel.callHost
  kernel.callHost = (async (method, input) => {
    const body = input as { account: string; value: string }
    if (method === "keychain.get") return { success: true, value: { value: vault.get(body.account) ?? null } }
    if (method === "keychain.set") {
      vault.set(body.account, body.value)
      return { success: true, value: {} }
    }
    if (method === "keychain.delete") {
      vault.delete(body.account)
      return { success: true, value: {} }
    }
    return host(method, input)
  }) as Kernel["callHost"]
  await initStore(kernel)
  const store = kernel.services.use("store.api")
  if (!store) throw new Error("store missing")
  const persistence = createRuntimePersistence({ database: kernel.db as Database })
  const runs: Array<Run> = []
  kernel.services.provide("runtime.enqueue", ({ threadId, requestMessageId, trigger }) => {
    const thread = store.getThread({ threadId })
    const run: Run = {
      id: kernel.newId(),
      threadId,
      botId: thread?.botId ?? "",
      provider: "codex",
      trigger,
      requestMessageId,
      replyMessageId: null,
      externalTurnId: null,
      status: "running",
      errorClass: null,
      errorMessage: null,
      usage: null,
      routineRunId: null,
      queuedAt: Date.now(),
      startedAt: Date.now(),
      finishedAt: null,
    }
    persistence.saveRun(run)
    runs.push(run)
    kernel.publish({ type: "run.updated", run })
    return { success: true, run }
  })
  const canceled: Array<string> = []
  kernel.services.provide(
    "runtime.activeRun",
    ({ threadId }) => runs.find((run) => run.threadId === threadId && run.status === "running") ?? null,
  )
  kernel.services.provide("runtime.cancelRun", ({ runId }) => {
    canceled.push(runId)
    return true
  })
  const answers: Array<{ approvalId: string; decision: string; message?: string }> = []
  kernel.services.provide("runtime.answerApproval", async (args) => {
    answers.push(args)
    return { success: true }
  })
  const resolved: Array<{ requestId: string; resolution: string }> = []
  kernel.services.provide("notify.resolve", (args) => {
    resolved.push(args)
  })
  const fake = createFakeTelegram({ token })
  const integrations = createTelegramIntegrations({ kernel, apiBase: fake.url, pollTimeoutSec: 0 })
  kernel.registerRoutes(integrations.routes)
  cleanup.push(async () => {
    await integrations.stopAll()
    fake.stop()
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
      method,
      headers: {
        Authorization: "Bearer dev-ui-token",
        "x-touri-client": "telegram-test",
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  const created = await request("POST", "/bots", { name: "Email", provider: "codex", instructions: "Ajude." })
  const bot = created.body.bot as Bot
  const telegram = async () =>
    ((await request("GET", `/bots/${bot.id}/integrations/telegram`)).body as { telegram: TelegramIntegration }).telegram
  const configure = async (body: Record<string, unknown>) => {
    const response = await request("PUT", `/bots/${bot.id}/integrations/telegram`, body)
    if (response.status !== 200) throw new Error(JSON.stringify(response.body))
    return (response.body as { telegram: TelegramIntegration }).telegram
  }
  const finish = (run: Run, text: string, getSnapshot: (run: Run) => Run = (run) => ({ ...run })) => {
    const reply = store.insertMessage({
      message: {
        id: kernel.newId(),
        threadId: run.threadId,
        parentId: run.requestMessageId,
        role: "assistant",
        kind: "text",
        status: "complete",
        runId: run.id,
        text,
        parts: [{ type: "text", text }],
        sender: null,
        source: "local",
      },
    })
    if (!reply.success) throw new Error(reply.error)
    Object.assign(run, { status: "succeeded", replyMessageId: reply.message.id, finishedAt: Date.now() })
    persistence.saveRun(run)
    kernel.publish({ type: "run.updated", run: getSnapshot(run) })
  }
  return {
    kernel,
    store,
    fake,
    runs,
    canceled,
    answers,
    resolved,
    bot,
    telegram,
    configure,
    finish,
    vault,
    request,
    integrations,
  }
}

const notification = (patch: Partial<NotificationRecord>): NotificationRecord => ({
  id: 1,
  kind: "approval",
  level: "warning",
  botId: null,
  botName: "Email",
  botColor: "#000",
  avatarShape: "classic-none",
  threadId: null,
  title: "Aprovar comando",
  body: "rm -rf /tmp/x",
  requestId: "request-1",
  createdAt: Date.now(),
  resolvedAt: null,
  resolution: null,
  ...patch,
})

test("Telegram is off by default, keeps the token secret and ignores senders outside the allowlist", async () => {
  const f = await fixture()
  expect(await f.telegram()).toMatchObject({
    config: { enabled: false, allowedUserIds: [], homeChatId: null, forwardRoutines: false },
    tokenSaved: false,
    status: { state: "off" },
  })
  const saved = await f.configure({ token: TOKEN, enabled: true })
  expect(saved.tokenSaved).toBe(true)
  expect(JSON.stringify(saved)).not.toContain(TOKEN)
  expect(f.kernel.redact(`token ${TOKEN}`)).not.toContain(TOKEN)
  await until(() => f.fake.sent("getUpdates").length > 0, "polling")
  expect((await f.telegram()).status).toEqual({ state: "connected", username: "touri_test_bot", error: null })
  f.fake.message({ from: 77, name: "Estranho", text: "oi" })
  await until(() => f.fake.sent("getUpdates").some((call) => Number(call.params.offset) === 2), "offset")
  expect(f.runs).toEqual([])
  expect(f.fake.sent()).toEqual([])
  expect((await f.telegram()).lastRejected).toMatchObject({ userId: "77", name: "Estranho" })
  expect(
    (f.kernel.db as Database).query("SELECT COUNT(*) AS n FROM threads WHERE title LIKE 'Telegram%'").get(),
  ).toEqual({ n: 0 })
})

test("engine snapshots keep the Telegram delivery thread when work has a separate group destination", async () => {
  const f = await fixture()
  const engine = createRuntimeEngine({ kernel: f.kernel })
  cleanup.push(() => engine.shutdown())
  await f.configure({ token: TOKEN, enabled: true, allowedUserIds: ["42"] })
  f.fake.message({ text: "Revisar o relatório" })
  await until(() => f.runs.length === 1, "run")
  const run = f.runs[0]
  const visible = f.store.createThread({ botId: f.bot.id, kind: "chat", title: "Equipe de demonstração" })
  if (!run || !visible.success) throw new Error("Missing conversation fixture")
  const database = f.kernel.db as Database
  database.query("UPDATE threads SET group_thread_id = ? WHERE id = ?").run(visible.thread.id, run.threadId)

  f.finish(run, "Relatório revisado.", engine.getRunSnapshot)
  await until(() => f.fake.sent().some((call) => call.params.text === "Relatório revisado."), "reply")

  expect(engine.getRunSnapshot(run)).toMatchObject({ threadId: run.threadId, groupThreadId: visible.thread.id })
  expect(f.fake.sent().filter((call) => call.params.text === "Relatório revisado.")).toHaveLength(1)
})

test("an allowed private chat maps to one thread, gets typing and receives the reply split under the limit", async () => {
  const f = await fixture()
  await f.configure({ token: TOKEN, enabled: true, allowedUserIds: ["42"] })
  f.fake.message({ text: "Resuma meus e-mails" })
  await until(() => f.runs.length === 1, "first run")
  const run = f.runs[0] as Run
  const thread = f.store.getThread({ threadId: run.threadId })
  expect(thread?.title).toBe("Telegram · Ana")
  expect(f.store.activePath({ threadId: run.threadId }).at(-1)?.text).toBe("Resuma meus e-mails")
  await until(() => f.fake.sent("sendChatAction").length > 0, "typing")
  const long = `Resumo:\n\`\`\`\n${"linha de código\n".repeat(400)}\`\`\`\nFim.`
  f.finish(run, long)
  await until(() => f.fake.sent().length >= 2, "reply chunks")
  const chunks = f.fake.sent().map((call) => String(call.params.text))
  expect(chunks.every((chunk) => chunk.length <= 4096)).toBe(true)
  for (const chunk of chunks) expect((chunk.match(/```/g) ?? []).length % 2).toBe(0)
  expect(chunks.join("\n")).toContain("Fim.")
  f.fake.message({ text: "E os de ontem?" })
  await until(() => f.runs.length === 2, "second run")
  expect(f.runs[1]?.threadId).toBe(run.threadId)
  f.fake.message({ text: "grupo", chatType: "group" })
  await until(() => f.fake.sent("getUpdates").some((call) => Number(call.params.offset) === 4), "group update")
  expect(f.runs).toHaveLength(2)
})

test("/stop cancels the active run and /new starts another thread", async () => {
  const f = await fixture()
  await f.configure({ token: TOKEN, enabled: true, allowedUserIds: ["42"] })
  f.fake.message({ text: "Começa" })
  await until(() => f.runs.length === 1, "run")
  f.fake.message({ text: "/stop" })
  await until(() => f.canceled.length === 1, "cancel")
  expect(f.canceled).toEqual([f.runs[0]?.id ?? ""])
  await until(() => f.fake.sent().some((call) => call.params.text === "Parei a resposta em andamento."), "stop reply")
  f.fake.message({ text: "/new" })
  await until(() => f.fake.sent().some((call) => String(call.params.text).startsWith("Nova conversa")), "new reply")
  f.fake.message({ text: "Outro assunto" })
  await until(() => f.runs.length === 2, "second run")
  expect(f.runs[1]?.threadId).not.toBe(f.runs[0]?.threadId)
})

test("approval buttons answer once, only for allowed users, and expire afterwards", async () => {
  const f = await fixture()
  await f.configure({ token: TOKEN, enabled: true, allowedUserIds: ["42"] })
  f.fake.message({ text: "Apague o arquivo" })
  await until(() => f.runs.length === 1, "run")
  f.kernel.publish({
    type: "notification.created",
    notification: notification({ botId: f.bot.id, threadId: f.runs[0]?.threadId ?? null }),
  })
  await until(() => f.fake.sent().some((call) => call.params.reply_markup), "prompt")
  const prompt = f.fake.sent().find((call) => call.params.reply_markup)
  const keyboard = prompt?.params.reply_markup as {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
  }
  const [approve] = keyboard.inline_keyboard[0] ?? []
  expect(approve?.text).toBe("Aprovar")
  expect(Buffer.byteLength(approve?.callback_data ?? "")).toBeLessThanOrEqual(64)
  f.fake.tap({ from: 99, name: "Outro", data: approve?.callback_data ?? "" })
  await until(() => f.fake.sent("answerCallbackQuery").length === 1, "denied tap")
  expect(f.fake.sent("answerCallbackQuery")[0]?.params.text).toBe("Sem permissão.")
  expect(f.answers).toEqual([])
  f.fake.tap({ data: approve?.callback_data ?? "" })
  await until(() => f.answers.length === 1, "answer")
  expect(f.answers[0]).toEqual({ approvalId: "request-1", decision: "approved" })
  expect(f.resolved).toEqual([{ requestId: "request-1", resolution: "allow" }])
  await until(() => f.fake.sent("editMessageText").length === 1, "edit")
  expect(String(f.fake.sent("editMessageText")[0]?.params.text)).toContain("Aprovado por Ana.")
  f.fake.tap({ data: approve?.callback_data ?? "" })
  await until(() => f.fake.sent("answerCallbackQuery").length === 3, "second tap")
  expect(f.fake.sent("answerCallbackQuery")[2]?.params.text).toBe("Pedido expirado.")
  expect(f.answers).toHaveLength(1)
})

test("routine results reach the home chat only when forwarding is on", async () => {
  const f = await fixture()
  await f.configure({ token: TOKEN, enabled: true, allowedUserIds: ["42"] })
  await until(() => f.fake.sent("getUpdates").length > 0, "polling")
  const routine = { id: "routine-1", botId: f.bot.id, name: "E-mails das 8h" } as Routine
  const finished = (id: string): RoutineRun => ({
    id,
    routineId: routine.id,
    scheduledFor: Date.now(),
    status: "succeeded",
    threadId: null,
    runId: null,
    triggerSource: "cron",
    summary: "3 e-mails importantes",
    startedAt: Date.now(),
    finishedAt: Date.now(),
  })
  f.kernel.publish({ type: "routine.updated", routine, lastRun: finished("run-a") })
  await Bun.sleep(30)
  expect(f.fake.sent()).toEqual([])
  await f.configure({ forwardRoutines: true, homeChatId: "42" })
  f.kernel.publish({ type: "routine.updated", routine, lastRun: finished("run-b") })
  f.kernel.publish({ type: "routine.updated", routine, lastRun: finished("run-b") })
  await until(() => f.fake.sent().length === 1, "routine delivery")
  expect(f.fake.sent()[0]?.params).toMatchObject({ chat_id: "42", text: "E-mails das 8h: 3 e-mails importantes" })
  await Bun.sleep(30)
  expect(f.fake.sent()).toHaveLength(1)
  await f.configure({ enabled: false })
  await f.configure({ enabled: true })
  f.kernel.publish({ type: "routine.updated", routine, lastRun: finished("run-b") })
  await Bun.sleep(30)
  expect(f.fake.sent()).toHaveLength(1)
})

test("a revoked token stops polling with a clear status, and invalid input is rejected", async () => {
  const f = await fixture({ token: "999999:SomeOtherTokenThatTheFakeExpects_1" })
  const saved = await f.configure({ token: TOKEN, enabled: true })
  expect(saved.tokenSaved).toBe(true)
  for (let i = 0; i < 100 && (await f.telegram()).status.state !== "error"; i++) await Bun.sleep(5)
  expect((await f.telegram()).status).toEqual({ state: "error", username: null, error: "Token inválido ou revogado." })
  const invalid = await f.request("PUT", `/bots/${f.bot.id}/integrations/telegram`, { token: "não é token" })
  expect(invalid.status).toBe(400)
  await f.configure({ allowedUserIds: ["42", "abc", "-100", "42"] })
  expect((await f.telegram()).config.allowedUserIds).toEqual(["42"])
  await f.configure({ token: null, enabled: false })
  expect(await f.telegram()).toMatchObject({ tokenSaved: false, status: { state: "off" } })
})

test("splitMessage keeps short text whole and never breaks a code fence or the limit", () => {
  expect(splitMessage("oi")).toEqual(["oi"])
  expect(splitMessage("")).toEqual([])
  const text = [
    "Antes",
    "```ts",
    ...Array.from({ length: 300 }, (_, i) => `const value${i} = ${i}`),
    "```",
    "Depois",
  ].join("\n")
  const chunks = splitMessage(text, 500)
  expect(chunks.length).toBeGreaterThan(1)
  for (const chunk of chunks) {
    expect(chunk.length).toBeLessThanOrEqual(500)
    expect((chunk.match(/```/g) ?? []).length % 2).toBe(0)
  }
  expect(chunks.at(-1)).toContain("Depois")
  const wide = splitMessage("x".repeat(1200), 500)
  expect(wide.map((chunk) => chunk.length)).toEqual([500, 500, 200])
})

test("reconnecting cannot reuse an old approval button, and buttons are bound to their private message", async () => {
  const f = await fixture()
  await f.configure({ token: TOKEN, enabled: true, allowedUserIds: ["42", "77"] })
  f.fake.message({ text: "Prepare uma ação" })
  await until(() => f.runs.length === 1)
  const publish = (requestId: string) =>
    f.kernel.publish({
      type: "notification.created",
      notification: notification({ requestId, botId: f.bot.id, threadId: f.runs[0]?.threadId ?? null }),
    })
  const button = (index: number) => {
    const markup = f.fake.sent()[index]?.params.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>
    }
    return markup.inline_keyboard[0]?.[0]?.callback_data ?? ""
  }
  publish("old-request")
  await until(() => f.fake.sent().length === 1)
  const old = button(0)
  await f.configure({ enabled: false })
  await f.configure({ enabled: true })
  publish("new-request")
  await until(() => f.fake.sent().length === 2)
  const current = button(1)
  f.fake.tap({ data: old })
  f.fake.tap({ from: 77, data: current })
  f.fake.tap({ data: current.replace(/:y$/, ":other") })
  await until(() => f.fake.sent("answerCallbackQuery").length === 3)
  expect(f.answers).toEqual([])
  expect(f.fake.sent("answerCallbackQuery").every((call) => call.params.text === "Pedido expirado.")).toBe(true)
  expect(current).not.toBe(old)
  f.fake.tap({ data: current })
  await until(() => f.answers.length === 1)
  expect(f.answers[0]?.approvalId).toBe("new-request")
})

test("removing a user prevents replies and approval notifications reaching their linked chat", async () => {
  const f = await fixture()
  await f.configure({ token: TOKEN, enabled: true, allowedUserIds: ["42"] })
  f.fake.message({ text: "Comece" })
  await until(() => f.runs.length === 1)
  await f.configure({ allowedUserIds: [] })
  const run = f.runs[0] as Run
  f.finish(run, "Conteúdo privado")
  f.kernel.publish({
    type: "notification.created",
    notification: notification({ botId: f.bot.id, threadId: run.threadId }),
  })
  await Bun.sleep(30)
  expect(f.fake.sent()).toEqual([])
})

test("changing the token resets the account offset and chat links; saving the same token preserves them", async () => {
  const f = await fixture()
  await f.configure({ token: TOKEN, enabled: true, allowedUserIds: ["42"] })
  f.fake.message({ text: "Conversa antiga" })
  await until(() => f.runs.length === 1)
  const store = createTelegramStore(f.kernel)
  await until(() => store.state(f.bot.id).offset === 2)
  const before = store.state(f.bot.id)
  await f.configure({ token: TOKEN })
  expect(store.state(f.bot.id)).toEqual(before)
  await f.configure({ token: "987654321:AAAnotherTokenForTouriTests_123456" })
  expect(store.state(f.bot.id)).toEqual({
    accountId: expect.any(String),
    updateEpoch: 0,
    offset: 0,
    chats: {},
    lastRejected: null,
    routineRunIds: [],
  })
  const sent = f.fake.sent().length
  f.finish(f.runs[0] as Run, "Não encaminhar para outra conta")
  await Bun.sleep(30)
  expect(f.fake.sent()).toHaveLength(sent)
})

test("a redelivered message keeps the original journal parent and never reports a nonce conflict", async () => {
  const f = await fixture()
  await f.configure({ token: TOKEN, enabled: true, allowedUserIds: ["42"] })
  f.fake.message({ text: "Uma vez só" })
  await until(() => f.runs.length === 1)
  const store = createTelegramStore(f.kernel)
  await until(() => store.state(f.bot.id).offset === 2)
  f.finish(f.runs[0] as Run, "Pronto")
  await until(() => f.fake.sent().length === 1)
  await f.configure({ enabled: false })
  store.saveState(f.bot.id, { ...store.state(f.bot.id), offset: 0 })
  await f.configure({ enabled: true })
  await until(() => store.state(f.bot.id).offset === 2)
  expect(f.runs).toHaveLength(1)
  expect(f.fake.sent().map((call) => call.params.text)).toEqual(["Pronto"])
})

test("shutdown waits for pending restarts without creating another poller", async () => {
  const f = await fixture()
  createTelegramStore(f.kernel).saveConfig(f.bot.id, {
    enabled: true,
    allowedUserIds: ["42"],
    homeChatId: null,
    forwardRoutines: false,
  })
  f.vault.set(tokenAccount(f.bot.id), TOKEN)
  const host = f.kernel.callHost
  let reading = false
  let release = () => {}
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  f.kernel.callHost = (async (method, input) => {
    if (method === "keychain.get") {
      reading = true
      await blocked
    }
    return host(method, input)
  }) as Kernel["callHost"]
  const started = f.integrations.start()
  await until(() => reading)
  const stopped = f.integrations.stopAll()
  release()
  await Promise.all([started, stopped])
  expect(f.fake.sent("getMe")).toEqual([])
  expect(f.integrations.status(f.bot.id).state).toBe("off")
})

test("shutdown aborts an in-flight command reply after acknowledging the processed command", async () => {
  const f = await fixture()
  await f.configure({ token: TOKEN, enabled: true, allowedUserIds: ["42"] })
  f.fake.respond((call) => (call.method === "sendMessage" ? new Promise<Response>(() => {}) : null))
  f.fake.message({ text: "/start" })
  await until(() => f.fake.sent().length === 1)
  await f.integrations.stopAll()
  expect(createTelegramStore(f.kernel).state(f.bot.id).offset).toBe(2)
})

test("failed secret removal keeps the existing token and reports failure", async () => {
  const f = await fixture()
  await f.configure({ token: TOKEN })
  const host = f.kernel.callHost
  f.kernel.callHost = (async (method, input) =>
    method === "keychain.delete"
      ? { success: false, errorCode: "UNAVAILABLE", error: "Vault unavailable" }
      : host(method, input)) as Kernel["callHost"]
  const result = await f.request("PUT", `/bots/${f.bot.id}/integrations/telegram`, { token: null, enabled: false })
  expect(result.status).toBe(500)
  expect((await f.telegram()).tokenSaved).toBe(true)
})

test("Telegram requests have a deadline and abortable sends without exposing the token", async () => {
  const f = await fixture()
  f.fake.respond(() => new Promise<Response>(() => {}))
  const api = createTelegramApi({ token: TOKEN, base: f.fake.url, timeoutMs: 20 })
  await expect(api.sendMessage({ chat_id: "42", text: "oi" })).rejects.toThrow("network error")
  const controller = new AbortController()
  const cancelable = createTelegramApi({ token: TOKEN, base: f.fake.url, signal: controller.signal })
  const sending = cancelable.sendMessage({ chat_id: "42", text: "oi" })
  controller.abort()
  await expect(sending).rejects.toThrow("network error")
})

test("message splitting handles large fences, closing markers and Unicode boundaries", () => {
  for (const text of [
    `antes\n${"`".repeat(501)}\nfim`,
    `${"x".repeat(490)}\n\`\`\`ts\nconteúdo\n\`\`\``,
    `\`\`\`ts\n${"x".repeat(490)}\n${"`".repeat(10)}`,
    `\`\`\`ts\n${"😀".repeat(700)}\n\`\`\``,
    `${"x".repeat(499)}😀${"y".repeat(600)}`,
  ]) {
    const chunks = splitMessage(text, 500)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(500)
      expect(Array.from(chunk).every((char) => char.length !== 1 || !/[\uD800-\uDFFF]/.test(char))).toBe(true)
    }
  }
  expect(() => splitMessage("hello", 0)).toThrow(RangeError)
})

test("an approval resolved during Telegram delivery stays expired and questions resolve as answers", async () => {
  const f = await fixture()
  await f.configure({ token: TOKEN, enabled: true, allowedUserIds: ["42"] })
  f.fake.message({ text: "Uma pergunta" })
  await until(() => f.runs.length === 1)
  const notice = notification({ botId: f.bot.id, threadId: f.runs[0]?.threadId ?? null })
  let release = (_response: Response) => {}
  f.fake.respond((call) =>
    call.method === "sendMessage"
      ? new Promise<Response>((resolve) => {
          release = resolve
        })
      : null,
  )
  f.kernel.publish({ type: "notification.created", notification: notice })
  await until(() => f.fake.sent().length === 1)
  f.kernel.publish({
    type: "notification.resolved",
    notification: { ...notice, resolvedAt: Date.now(), resolution: "allow" },
  })
  release(Response.json({ ok: true, result: { message_id: 501, chat: { id: 42, type: "private" } } }))
  await until(() => f.fake.sent("editMessageText").some((call) => call.params.message_id === 501))
  const markup = f.fake.sent()[0]?.params.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }
  f.fake.tap({ data: markup.inline_keyboard[0]?.[0]?.callback_data ?? "", promptMessageId: 501 })
  await until(() => f.fake.sent("answerCallbackQuery").length === 1)
  expect(f.answers).toEqual([])
  f.fake.respond(null)
  f.kernel.publish({
    type: "notification.created",
    notification: { ...notice, requestId: "question-1", kind: "question" },
  })
  await until(() => f.fake.sent().length === 2)
  const questionMarkup = f.fake.sent()[1]?.params.reply_markup as {
    inline_keyboard: Array<Array<{ callback_data: string }>>
  }
  f.fake.tap({ data: questionMarkup.inline_keyboard[0]?.[0]?.callback_data ?? "" })
  await until(() => f.answers.length === 1)
  expect(f.answers[0]).toMatchObject({ decision: "denied", message: "User answered: yes" })
  expect(f.resolved.at(-1)).toEqual({ requestId: "question-1", resolution: "answer" })
})

test("deleting a bot while its token is being read cannot resurrect a bridge or its settings", async () => {
  const f = await fixture()
  const state = createTelegramStore(f.kernel)
  state.saveConfig(f.bot.id, { enabled: true, allowedUserIds: ["42"], homeChatId: null, forwardRoutines: false })
  f.vault.set(tokenAccount(f.bot.id), TOKEN)
  const host = f.kernel.callHost
  let reading = false
  let release = () => {}
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  f.kernel.callHost = (async (method, input) => {
    const result = await host(method, input)
    if (method === "keychain.get") {
      reading = true
      await blocked
    }
    return result
  }) as Kernel["callHost"]
  const started = f.integrations.start()
  await until(() => reading)
  ;(f.kernel.db as Database).query("DELETE FROM bots WHERE id = ?").run(f.bot.id)
  f.kernel.publish({ type: "bot.deleted", botId: f.bot.id })
  release()
  await started
  await until(() => !f.vault.has(tokenAccount(f.bot.id)))
  expect(f.fake.sent("getMe")).toEqual([])
  expect(state.configuredBots()).not.toContain(f.bot.id)
})

test("long approval requests require the complete context in the app instead of truncated buttons", async () => {
  const f = await fixture()
  await f.configure({ token: TOKEN, enabled: true, allowedUserIds: ["42"] })
  f.fake.message({ text: "Confira o pedido" })
  await until(() => f.runs.length === 1)
  f.kernel.publish({
    type: "notification.created",
    notification: notification({
      botId: f.bot.id,
      threadId: f.runs[0]?.threadId ?? null,
      body: "ação longa ".repeat(500),
    }),
  })
  await until(() => f.fake.sent().length === 1)
  expect(f.fake.sent()[0]?.params.text).toBe("Este pedido é longo. Abra o touri para conferir e responder.")
  expect(f.fake.sent()[0]?.params.reply_markup).toBeUndefined()
})

test("/new clears typing from the previous conversation while the new conversation is idle", async () => {
  const f = await fixture()
  const store = createTelegramStore(f.kernel)
  store.saveConfig(f.bot.id, { enabled: true, allowedUserIds: ["42"], homeChatId: null, forwardRoutines: false })
  const bridge = createTelegramBridge({
    kernel: f.kernel,
    botId: f.bot.id,
    token: TOKEN,
    store,
    apiBase: f.fake.url,
    pollTimeoutSec: 0,
    typingIntervalMs: 10,
    onStatus: () => undefined,
  })
  cleanup.push(() => bridge.stop())
  bridge.start()
  f.fake.message({ text: "Comece um trabalho" })
  await until(() => f.runs.length === 1 && f.fake.sent("sendChatAction").length > 0)

  f.fake.message({ text: "/new" })
  await until(() => f.fake.sent().some((call) => String(call.params.text).startsWith("Nova conversa:")))
  f.fake.message({ text: "/status" })
  await until(() => f.fake.sent().some((call) => String(call.params.text).includes("Nada em andamento.")))
  await Bun.sleep(30)
  const typing = f.fake.sent("sendChatAction").length
  await Bun.sleep(40)

  expect(f.runs[0]?.status).toBe("running")
  expect(f.fake.sent("sendChatAction")).toHaveLength(typing)
})

test.each([false, true])(
  "restart scopes saved chat links and offsets to the credential account (legacy: %s)",
  async (legacy) => {
    const f = await fixture()
    await f.configure({ token: TOKEN, enabled: true, allowedUserIds: ["42"] })
    f.fake.message({ text: "Conversa da conta anterior" })
    await until(() => f.runs.length === 1)
    const store = createTelegramStore(f.kernel)
    await until(() => store.state(f.bot.id).offset === 2)
    await f.configure({ enabled: false })
    const nextToken = "987654321:AAAnotherTokenForTouriTests_123456"
    const nextAccount = createFakeTelegram({ token: nextToken })
    cleanup.push(() => {
      nextAccount.stop()
    })
    // A process can stop after storing a replacement credential but before clearing the settings row.
    if (legacy) store.saveState(f.bot.id, { ...store.state(f.bot.id), accountId: null })
    f.vault.set(tokenAccount(f.bot.id), nextToken)
    store.saveConfig(f.bot.id, { ...store.config(f.bot.id), enabled: true })
    const restarted = createTelegramIntegrations({ kernel: f.kernel, apiBase: nextAccount.url, pollTimeoutSec: 0 })
    cleanup.push(() => restarted.stopAll())

    await restarted.start()
    await until(() => nextAccount.sent("getUpdates").length > 0)
    f.finish(f.runs[0] as Run, "Resultado da conta anterior")
    await Bun.sleep(20)

    expect(nextAccount.sent("getUpdates")[0]?.params.offset).toBe(0)
    expect(store.state(f.bot.id).chats).toEqual({})
    expect(nextAccount.sent()).toEqual([])

    nextAccount.message({ text: "Conversa da nova conta" })
    await until(() => f.runs.length === 2)
    expect(f.runs[1]?.threadId).not.toBe(f.runs[0]?.threadId)
  },
)

test("verified legacy conversations keep their thread and polling offset during upgrade", async () => {
  const f = await fixture()
  await f.configure({ token: TOKEN, enabled: true, allowedUserIds: ["42"] })
  f.fake.message({ text: "Primeira mensagem" })
  await until(() => f.runs.length === 1)
  const store = createTelegramStore(f.kernel)
  await until(() => store.state(f.bot.id).offset === 2)
  f.finish(f.runs[0] as Run, "Primeira resposta")
  await until(() => f.fake.sent().length === 1)
  await f.configure({ enabled: false })
  const before = store.state(f.bot.id)
  store.saveState(f.bot.id, { ...before, accountId: null })

  await f.configure({ enabled: true })

  expect(store.state(f.bot.id)).toMatchObject({ chats: before.chats, offset: before.offset })
  f.fake.message({ text: "Continue a conversa" })
  await until(() => f.runs.length === 2)
  expect(f.runs[1]?.threadId).toBe(f.runs[0]?.threadId)
})

test("a restarted update sequence delivers and deduplicates a private message without losing its conversation", async () => {
  const f = await fixture()
  await f.configure({ token: TOKEN, enabled: true, allowedUserIds: ["42"] })
  f.fake.message({ text: "Mensagem da sequência anterior" })
  await until(() => f.runs.length === 1)
  const store = createTelegramStore(f.kernel)
  await until(() => store.state(f.bot.id).offset === 2)
  f.finish(f.runs[0] as Run, "Resposta anterior")
  await until(() => f.fake.sent().length === 1)
  await f.configure({ enabled: false })
  store.saveState(f.bot.id, { ...store.state(f.bot.id), offset: 100 })
  const reset = {
    update_id: 1,
    message: {
      message_id: 501,
      from: { id: 42, first_name: "Ana" },
      chat: { id: 42, type: "private" },
      text: "Mensagem da nova sequência",
    },
  }
  // The Bot API falls back to the queue head when a saved offset is beyond a restarted range.
  f.fake.respond((call) =>
    call.method === "getUpdates" && (Number(call.params.offset) === 100 || Number(call.params.offset) <= 1)
      ? Response.json({ ok: true, result: [reset] })
      : null,
  )

  await f.configure({ enabled: true })
  await until(() => f.runs.length === 2 && store.state(f.bot.id).offset === 2)

  expect(f.runs[1]?.threadId).toBe(f.runs[0]?.threadId)
  expect(store.state(f.bot.id).updateEpoch).toBe(1)
  expect(f.store.activePath({ threadId: f.runs[1]?.threadId ?? "" }).at(-1)?.text).toBe(reset.message.text)

  await f.configure({ enabled: false })
  store.saveState(f.bot.id, { ...store.state(f.bot.id), offset: 0 })
  await f.configure({ enabled: true })
  await until(() => store.state(f.bot.id).offset === 2)
  expect(f.runs).toHaveLength(2)
  expect(f.fake.sent().some((call) => call.params.text === "Não consegui entregar a mensagem ao bot.")).toBe(false)
})

test("long replies retry a flood-rejected chunk without resending accepted chunks", async () => {
  const f = await fixture()
  await f.configure({ token: TOKEN, enabled: true, allowedUserIds: ["42"] })
  f.fake.message({ text: "Uma resposta longa" })
  await until(() => f.runs.length === 1)
  const first = "a".repeat(4096)
  const second = "b".repeat(900)
  f.fake.respond((call) =>
    call.method === "sendMessage" &&
    call.params.text === second &&
    f.fake.sent().filter((attempt) => attempt.params.text === second).length === 1
      ? Response.json(
          { ok: false, error_code: 429, description: "Too many requests", parameters: { retry_after: 1 } },
          { status: 429 },
        )
      : null,
  )

  f.finish(f.runs[0] as Run, first + second)
  await until(() => f.fake.sent().length === 3)
  f.kernel.publish({ type: "run.updated", run: f.runs[0] as Run })
  await Bun.sleep(20)

  expect(f.fake.sent().map((call) => call.params.text)).toEqual([first, second, second])
})

test("removing a sender during a flood wait prevents the retry", async () => {
  const f = await fixture()
  await f.configure({ token: TOKEN, enabled: true, allowedUserIds: ["42"] })
  f.fake.message({ text: "Comece" })
  await until(() => f.runs.length === 1)
  f.fake.respond((call) =>
    call.method === "sendMessage"
      ? Response.json(
          { ok: false, error_code: 429, description: "Too many requests", parameters: { retry_after: 1 } },
          { status: 429 },
        )
      : null,
  )

  f.finish(f.runs[0] as Run, "Resposta privada")
  await until(() => f.fake.sent().length === 1)
  await f.configure({ allowedUserIds: [] })
  await Bun.sleep(1_500)

  expect(f.fake.sent()).toHaveLength(1)
})

test("a rate-limited command reply does not prevent the next stop command", async () => {
  const f = await fixture()
  await f.configure({ token: TOKEN, enabled: true, allowedUserIds: ["42"] })
  f.fake.message({ text: "Comece" })
  await until(() => f.runs.length === 1)
  f.fake.respond((call) =>
    call.method === "sendMessage"
      ? Response.json(
          { ok: false, error_code: 429, description: "Too many requests", parameters: { retry_after: 30 } },
          { status: 429 },
        )
      : null,
  )

  f.fake.message({ text: "/status" })
  await until(() => f.fake.sent().length === 1)
  f.fake.message({ text: "/stop" })
  await until(() => f.canceled.length === 1)

  expect(f.canceled).toEqual([f.runs[0]?.id ?? ""])
})
