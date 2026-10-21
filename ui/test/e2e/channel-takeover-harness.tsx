import type { ApiRoutes, BrowserTabInfo, Message, NotificationRecord, Run, ToolCallPart } from "@touri/contracts"
import { useEffect } from "react"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { t } from "../../src/i18n"
import "../../src/styles.css"

const base = createMockApi()
const baseRequest = base.request
const { bots } = base.getState()
const bot = bots[0]
if (!bot) throw new Error("Fixture bot is missing")
Object.assign(bot, { name: "Planejamento", title: "Planejamento", mainThreadId: "thread-channel-bot" })
const { thread } = await base.request("POST /groups", {
  name: "Equipe de viagens",
  color: "#2563eb",
  avatarShape: "classic-none",
  memberIds: [bot.id],
  coordinatorBotId: null,
})
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
  takeoverRunId: null,
  lastUsedAt: Date.now(),
}

localStorage.setItem(
  "touri.workspace.v1",
  JSON.stringify({ botId: bot.id, threadId: channel.id, route: { section: "bots", screen: "chat" } }),
)

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
  sender: role === "assistant" ? { id: bot.id, name: bot.name } : null,
  source: "local",
  createdAt: getTimestamp(),
  updatedAt: getTimestamp(),
})

const getBrowserAction = (callId: string, action: "request_takeover" | "snapshot"): ToolCallPart => ({
  type: "tool_call",
  callId,
  tool: `mcp__touri__browser_${action}`,
  summary: action,
  inputJson: JSON.stringify({ tabId: browserTab.tabId, ...(action === "request_takeover" ? { reason: "login" } : {}) }),
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
  browserTab.takeoverRunId = takeoverRequested ? "run-channel-login" : null
  browserTab.lastUsedAt = getTimestamp()
  base.emit({ type: "browser.tab", tab: browserTab })
}

const resumeInChannel = (): void => {
  if (!takeoverNotice || channelRuns.length < 1) return
  const previous = channelRuns[0]
  const previousReply = channelMessages.find((entry) => entry.id === previous?.replyMessageId)
  if (!previous || !previousReply) return

  takeoverNotice.resolvedAt = getTimestamp()
  takeoverNotice.resolution = "replied"
  base.emit({ type: "notification.resolved", notification: takeoverNotice })
  updateTakeover(false, false)
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
    threadId: channel.id,
    botId: bot.id,
    provider: bot.provider,
    trigger: "retry",
    origin: "resume",
    browserTakeoverFromRunId: previous.id,
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

const harnessWindow: Window & { completeChannelResume?: () => void } = window
harnessWindow.completeChannelResume = () => finishResumedAnswer?.()

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
      image:
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='500'%3E%3Crect width='100%25' height='100%25' fill='%23f8fafc'/%3E%3Ctext x='48' y='110' font-size='28' fill='%230f172a'%3EPortal de demonstra%C3%A7%C3%A3o%3C/text%3E%3Ctext x='48' y='180' font-size='22' fill='%23475569'%3EFa%C3%A7a login para continuar%3C/text%3E%3C/svg%3E",
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
    if (pendingRun && pendingReply) {
      pendingRun.status = "succeeded"
      pendingRun.finishedAt = getTimestamp()
      pendingReply.status = "complete"
      pendingReply.updatedAt = getTimestamp()
      emitRun(pendingRun)
      base.emit({ type: "message.updated", message: pendingReply })
    }
    return { message: userMessage, run } as ApiRoutes[K]["res"]
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
