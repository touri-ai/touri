import type { ApiRoutes, BrowserTabInfo, Message, NotificationRecord, Run, ToolCallPart } from "@touri/contracts"
import { useEffect } from "react"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { t } from "../../src/i18n"
import "../../src/styles.css"

const base = createMockApi()
const params = new URLSearchParams(location.search)
const direct = params.get("direct") === "true"
const baseRequest = base.request
const { bots } = base.getState()
const bot = bots[0]
if (!bot) throw new Error("Fixture bot is missing")
Object.assign(bot, { name: "Planejamento", title: "Planejamento", mainThreadId: "thread-channel-bot" })
const { thread } = await (direct
  ? base.request("POST /threads", { botId: bot.id, title: "Portal de demonstração" })
  : base.request("POST /groups", {
      name: "Equipe de viagens",
      color: "#2563eb",
      avatarShape: "classic-none",
      memberIds: [bot.id],
      coordinatorBotId: null,
    }))
if (direct) Object.assign(bot, { mainThreadId: thread.id })
thread.title = "Planejar viagem"
thread.activeLeafId = null
const channel = thread
const browserTab: BrowserTabInfo & { ownerBotId: string | null } = {
  tabId: "tab-demo-login",
  ownerBotId: bot.id,
  url: "https://portal.example.test/login",
  title: "Portal de demonstração · Entrar",
  state: "live",
  openerTabId: null,
  heldByUser: false,
  takeoverRequested: false,
  lastUsedAt: Date.now(),
}

localStorage.setItem(
  "touri.workspace.v1",
  JSON.stringify({ botId: bot.id, threadId: channel.id, route: { section: "bots", screen: "chat" } }),
)

const previewCanvas = document.createElement("canvas")
previewCanvas.width = 800
previewCanvas.height = 500
const previewDrawing = previewCanvas.getContext("2d")
if (previewDrawing) {
  previewDrawing.fillStyle = "#f4f4f5"
  previewDrawing.fillRect(0, 0, 800, 500)
  previewDrawing.fillStyle = "#242429"
  previewDrawing.font = "28px sans-serif"
  previewDrawing.fillText("Portal de demonstração", 48, 100)
  previewDrawing.font = "20px sans-serif"
  previewDrawing.fillText("Página fictícia para conferir a devolução", 48, 150)
}
const previewImage = previewCanvas.toDataURL("image/jpeg")

const channelMessages: Message[] = []
const channelRuns: Run[] = []
let takeoverNotice: NotificationRecord | null = null
let messageNumber = 0
let finishResumedAnswer: (() => void) | null = null
const getTimestamp = (): number => Date.now()
const getMessage = ({
  id,
  role,
  text,
  runId = null,
  parentId = null,
  status = "complete",
  parts = [{ type: "text", text }],
}: {
  id: string
  role: Message["role"]
  text: string
  runId?: string | null
  parentId?: string | null
  status?: Message["status"]
  parts?: Message["parts"]
}): Message => ({
  id,
  threadId: channel.id,
  parentId,
  role,
  kind: role === "system" ? "notice" : "text",
  status,
  runId,
  text,
  parts,
  sender: role === "assistant" && !direct ? { id: bot.id, name: bot.name } : null,
  source: "local",
  createdAt: getTimestamp(),
  updatedAt: getTimestamp(),
})

const getBrowserAction = (callId: string, action: "open" | "request_takeover" | "snapshot"): ToolCallPart => ({
  type: "tool_call",
  callId,
  tool: `mcp__touri__browser_${action}`,
  summary: action,
  inputJson: JSON.stringify({
    tabId: browserTab.tabId,
    ...(action === "open" ? { url: browserTab.url } : {}),
    ...(action === "request_takeover" ? { reason: "login" } : {}),
  }),
  outputJson: JSON.stringify({ structured: { status: action === "request_takeover" ? "waiting_for_person" : "ok" } }),
  startedAt: getTimestamp(),
  resolvedAt: getTimestamp(),
  ok: true,
})

const emitMessage = (entry: Message, type: "message.created" | "message.updated" = "message.created"): void => {
  channelMessages.push(entry)
  base.emit({ type, message: entry })
}
const emitRun = (run: Run): void => {
  base.emit({ type: "run.updated", run })
}

const updateTakeover = (heldByUser: boolean, takeoverRequested: boolean): void => {
  browserTab.heldByUser = heldByUser
  browserTab.takeoverRequested = takeoverRequested
  browserTab.lastUsedAt = getTimestamp()
  base.emit({ type: "browser.tab", tab: browserTab })
}

const resumeInChannel = (): void => {
  if (!takeoverNotice || takeoverNotice.resolvedAt !== null || channelRuns.length < 1) return
  const previous = channelRuns[0]
  const previousReply = channelMessages.find((entry) => entry.id === previous?.replyMessageId)
  if (!previous || !previousReply) return

  takeoverNotice.resolvedAt = getTimestamp()
  takeoverNotice.resolution = "replied"
  base.emit({ type: "notification.resolved", notification: takeoverNotice })
  updateTakeover(false, false)
  previous.browserWaitingForPerson = false
  previous.status = "succeeded"
  previous.finishedAt = getTimestamp()
  previousReply.status = "complete"
  previousReply.updatedAt = getTimestamp()
  emitRun(previous)
  base.emit({ type: "message.updated", message: previousReply })

  const markerText = "Retomado após a devolução do navegador"
  const marker = getMessage({
    id: `channel-message-${++messageNumber}`,
    role: "system",
    text: markerText,
    parts: [{ type: "notice", level: "info", code: "run_resumed", text: markerText }],
    parentId: previousReply.id,
  })
  emitMessage(marker)

  const run: Run = {
    id: "run-channel-resume",
    browserRequestId: previous.browserRequestId ?? previous.id,
    threadId: channel.id,
    botId: bot.id,
    provider: bot.provider,
    trigger: "retry",
    origin: "resume",
    requestMessageId: marker.id,
    replyMessageId: null,
    externalTurnId: "turn-channel-resume",
    status: "running",
    errorClass: null,
    errorMessage: null,
    usage: null,
    routineRunId: null,
    queuedAt: getTimestamp(),
    startedAt: getTimestamp(),
    finishedAt: null,
  }
  const reply = getMessage({
    id: `channel-message-${++messageNumber}`,
    role: "assistant",
    text: "",
    status: "streaming",
    runId: run.id,
    parentId: marker.id,
    parts: [getBrowserAction("resume-page-check", "snapshot")],
  })
  run.replyMessageId = reply.id
  channelRuns.push(run)
  base.emit({ type: "message.created", message: reply })
  emitRun(run)
  if (direct)
    base.emit({
      type: "thread.updated",
      thread: Object.assign({}, channel, { activeLeafId: reply.id, updatedAt: getTimestamp() }),
    })

  finishResumedAnswer = () => {
    finishResumedAnswer = null
    const answer = t("O portal de demonstração está pronto para continuar.", {}, "pt-BR")
    reply.text = answer
    reply.parts = [getBrowserAction("resume-page-check", "snapshot"), { type: "text", text: answer }]
    reply.status = "complete"
    reply.updatedAt = getTimestamp()
    run.status = "succeeded"
    run.finishedAt = getTimestamp()
    base.emit({ type: "message.updated", message: reply })
    emitRun(run)
  }
}

const harnessWindow: Window & {
  completeChannelResume?: () => void
  completeWaitingReply?: () => void
  expireChannelHandoff?: () => void
} = window
harnessWindow.completeChannelResume = () => finishResumedAnswer?.()
harnessWindow.completeWaitingReply = () => {
  const run = channelRuns[0]
  const reply = channelMessages.find((message) => message.id === run?.replyMessageId)
  if (!run || !reply) return

  emitRun(Object.assign({}, run, { status: "succeeded", finishedAt: getTimestamp() }))
  base.emit({ type: "message.updated", message: Object.assign({}, reply, { status: "complete" }) })
}
harnessWindow.expireChannelHandoff = () => {
  const run = channelRuns[0]
  const reply = channelMessages.find((message) => message.id === run?.replyMessageId)
  if (!run || !reply) return

  base.emit({
    type: "message.updated",
    message: Object.assign({}, reply, {
      status: "complete",
      parts: reply.parts.concat({
        type: "notice",
        level: "warning",
        code: "run_failed",
        text: "No one took over in time. Ask again when you can.",
      }),
    }),
  })
  emitRun(Object.assign({}, run, { status: "succeeded", finishedAt: getTimestamp(), browserWaitingForPerson: false }))
  updateTakeover(false, false)
  if (takeoverNotice)
    base.emit({
      type: "notification.resolved",
      notification: Object.assign({}, takeoverNotice, { resolvedAt: getTimestamp(), resolution: "expired" }),
    })
}

const request: ApiRequest = async <K extends keyof ApiRoutes>(
  route: K,
  input: ApiRoutes[K]["req"],
  pathValues: Record<string, string> = {},
): Promise<ApiRoutes[K]["res"]> => {
  const key = String(route)
  if (key === "GET /browser/tabs") return { tabs: [{ ...browserTab }], lastFailure: null } as ApiRoutes[K]["res"]
  if (key === "GET /bots/:id/browser-preview")
    return {
      title: browserTab.title,
      url: browserTab.url,
      image: previewImage,
    } as ApiRoutes[K]["res"]
  if (key === "GET /threads/:id/messages" && pathValues.id === channel.id)
    return { messages: [...channelMessages], activeLeafId: channelMessages.at(-1)?.id ?? null } as ApiRoutes[K]["res"]
  if (key === "GET /threads/:id/runs" && pathValues.id === channel.id)
    return { runs: [...channelRuns] } as ApiRoutes[K]["res"]
  if (key === "GET /runs") return { runs: channelRuns.filter((run) => run.status === "running") } as ApiRoutes[K]["res"]
  if (key === "GET /workspace/activity") {
    const existing = await baseRequest("GET /workspace/activity", {})
    return {
      ...existing,
      messages: [...existing.messages, ...channelMessages],
      runs: [...existing.runs, ...channelRuns],
    } as ApiRoutes[K]["res"]
  }
  if (key === "POST /threads/:id/messages" && pathValues.id === channel.id) {
    const sent = input as ApiRoutes["POST /threads/:id/messages"]["req"]
    const userMessage = getMessage({
      id: `channel-message-${++messageNumber}`,
      role: "user",
      text: sent.text,
      parentId: sent.parentId ?? null,
    })
    const run: Run = {
      id: "run-channel-login",
      browserRequestId: "run-channel-login",
      browserWaitingForPerson: true,
      threadId: channel.id,
      botId: bot.id,
      provider: bot.provider,
      trigger: "user",
      origin: "message",
      requestMessageId: userMessage.id,
      replyMessageId: null,
      externalTurnId: "turn-channel-login",
      status: "running",
      errorClass: null,
      errorMessage: null,
      usage: null,
      routineRunId: null,
      queuedAt: getTimestamp(),
      startedAt: getTimestamp(),
      finishedAt: null,
    }
    const reply = getMessage({
      id: `channel-message-${++messageNumber}`,
      role: "assistant",
      text: t("O portal de demonstração pediu login para continuar.", {}, "pt-BR"),
      status: "streaming",
      runId: run.id,
      parentId: userMessage.id,
      parts: [
        { type: "text", text: t("O portal de demonstração pediu login para continuar.", {}, "pt-BR") },
        getBrowserAction("portal-open", "open"),
        getBrowserAction("login-takeover", "request_takeover"),
      ],
    })
    run.replyMessageId = reply.id
    channelRuns.push(run)
    emitMessage(userMessage)
    emitMessage(reply)
    emitRun(run)
    takeoverNotice = base.notify({
      kind: "takeover",
      botId: bot.id,
      threadId: channel.id,
      requestId: "browser-takeover:tab-demo-login",
      title: "Browser takeover",
      body: "needs you in the browser: login",
    })
    updateTakeover(false, true)
    const pendingRun = channelRuns[0]
    const pendingReply = channelMessages.find((entry) => entry.id === pendingRun?.replyMessageId)
    if (pendingRun && pendingReply && params.get("streaming") !== "true") {
      pendingRun.status = "succeeded"
      pendingRun.finishedAt = getTimestamp()
      pendingReply.status = "complete"
      pendingReply.updatedAt = getTimestamp()
      emitRun(pendingRun)
      base.emit({ type: "message.updated", message: pendingReply })
    }
    // A direct reply becomes the active branch after the send response has settled.
    if (direct)
      setTimeout(() => {
        base.emit({
          type: "thread.updated",
          thread: Object.assign({}, channel, { activeLeafId: reply.id, updatedAt: getTimestamp() }),
        })
      }, 0)
    return { message: userMessage, run } as ApiRoutes[K]["res"]
  }
  if (key === "POST /browser/tabs/:id/takeover/session") {
    updateTakeover(true, true)
    if (params.get("legacyTakeoverNotice") === "true")
      base.emit({
        type: "notify",
        level: "info",
        title: "Browser takeover",
        body: "The user took over the browser: The user requested browser takeover",
        threadId: channel.id,
      })
    return { sessionId: "channel-session", controlEpoch: "channel-control", viewEpoch: 0 } as ApiRoutes[K]["res"]
  }
  if (key === "POST /browser/tabs/:id/takeover/frame")
    return {
      controlEpoch: "channel-control",
      targetEpoch: 1,
      viewEpoch: (input as { viewEpoch: number }).viewEpoch,
      title: browserTab.title,
      url: browserTab.url,
      image: previewImage,
      width: 800,
      height: 500,
    } as ApiRoutes[K]["res"]
  if (key === "DELETE /browser/tabs/:id/takeover/session") {
    resumeInChannel()
    return {} as ApiRoutes[K]["res"]
  }
  if (key === "POST /browser/tabs/:id/takeover") {
    const held = (input as ApiRoutes["POST /browser/tabs/:id/takeover"]["req"]).hold
    updateTakeover(held, held)
    if (!held) resumeInChannel()
    return {} as ApiRoutes[K]["res"]
  }

  return baseRequest(route, input, pathValues)
}
base.request = request

const Harness = () => {
  useEffect(() => {
    document.documentElement.dataset.theme = "light"
    document.documentElement.lang = "pt-BR"
  }, [])
  return <App kernel={{ services: { api: base } }} />
}

const root = document.getElementById("root")
if (root) createRoot(root).render(<Harness />)
