import type { BrowserChannelRun, Message, Run, ToolCallPart } from "@touri/contracts"
import type { ApiRequest } from "../../src/api/client"
import type { createMockApi } from "../../src/api/mock"

export const installWorkBrowserFixture = async (api: ReturnType<typeof createMockApi>, mode: string): Promise<void> => {
  const bot = api.getState().bots.find((candidate) => candidate.id === "bot-mark")
  if (!bot) throw new Error("Missing synthetic bot")
  Object.assign(bot, { name: "Léo", responsiblePersonId: "owner" })
  const { group, thread } = await api.request("POST /groups", {
    name: "Viagens",
    color: "#c2410c",
    avatarShape: "classic-none",
    memberIds: [bot.id],
    coordinatorBotId: null,
  })
  const held = mode === "held"
  const finished = mode === "finished"
  const now = Date.now()
  const getPart = (callId: string, tool: string, complete: boolean): ToolCallPart => ({
    type: "tool_call",
    callId,
    tool: `mcp__touri__${tool}`,
    browserRequestId: "request",
    summary: "Synthetic browser action",
    inputJson: JSON.stringify({ tabId: "work-tab", url: "https://estadias.example.test/busca" }),
    outputJson: JSON.stringify({ structured: { tabId: "work-tab" } }),
    ok: complete ? true : null,
    startedAt: now - 5000,
    resolvedAt: complete ? now - 1000 : null,
  })
  const prompt: Message = {
    id: "request",
    threadId: thread.id,
    parentId: null,
    role: "user",
    kind: "text",
    status: "complete",
    runId: null,
    text: "@Léo pesquise duas estadias em Chicago, com nota e preço total.",
    parts: [{ type: "text", text: "@Léo pesquise duas estadias em Chicago, com nota e preço total." }],
    sender: { id: "ana", name: "Ana", kind: "person", avatarSeed: "ana" },
    source: "local",
    createdAt: now - 6000,
    updatedAt: now - 6000,
  }
  const narration = "Abri a busca. Agora estou conferindo as opções e os preços."
  const reply: Message = {
    id: "reply",
    threadId: thread.id,
    parentId: prompt.id,
    role: "assistant",
    kind: "text",
    status: finished ? "complete" : "streaming",
    runId: "work-run",
    text: narration,
    parts: [
      { type: "text", text: narration },
      getPart("open", "browser_open", true),
      getPart("type", "browser_type", true),
      getPart("read", "browser_snapshot", finished),
    ],
    sender: { id: bot.id, name: bot.name },
    source: "local",
    createdAt: now - 5000,
    updatedAt: now,
  }
  const answer =
    "1. **Estadia Lago** — nota 9,4; total de US$ 848 por quatro noites.\n2. **Estadia Centro** — nota 9,2; total de US$ 920 por quatro noites.\n\nDados fictícios para testar a interface."
  const final: Message = Object.assign({}, reply, {
    id: "resumed-reply",
    parentId: reply.id,
    runId: "resumed-run",
    text: answer,
    parts: [
      Object.assign({}, getPart("final", "browser_screenshot", true), { outputAttachmentId: "work-final-image" }),
      { type: "text", text: answer },
    ],
    createdAt: now,
    updatedAt: now,
  })
  // The fixture owns this synthetic state and seeds it before the app mounts.
  api.getState().messages.push(prompt, reply, ...(finished ? [final] : []))
  Object.assign(thread, { activeLeafId: finished ? final.id : reply.id })
  const storedThread = api.getState().threads.find((candidate) => candidate.id === thread.id)
  if (storedThread) Object.assign(storedThread, { activeLeafId: thread.activeLeafId })
  const run: Run = {
    id: "work-run",
    botId: bot.id,
    threadId: thread.id,
    provider: bot.provider,
    trigger: "user",
    requestMessageId: prompt.id,
    replyMessageId: reply.id,
    externalTurnId: null,
    status: finished ? "succeeded" : "running",
    errorClass: null,
    errorMessage: null,
    usage: null,
    routineRunId: null,
    queuedAt: now - 6000,
    startedAt: now - 5000,
    finishedAt: finished ? now : null,
  }
  const browserRun: BrowserChannelRun = {
    runId: run.id,
    requestId: prompt.id,
    activeRunId: finished ? "resumed-run" : run.id,
    runIds: [run.id, "resumed-run"],
    groupId: group.id,
    threadId: thread.id,
    botId: bot.id,
    requesterPersonId: "ana",
    requesterName: "Ana",
    responsiblePersonId: "owner",
    controllerPersonId: held ? "ana" : null,
    controllerName: held ? "Ana" : null,
    status: held ? "taken_over" : finished ? "succeeded" : "running",
    queuePosition: null,
    queuedAt: now - 6000,
    startedAt: now - 5000,
    needsYouAt: null,
    escalatedAt: null,
    finishedAt: finished ? now : null,
  }
  const image = getSyntheticPage()
  const request = api.request
  api.request = (async (route, body, params, transport) => {
    if (route === "GET /groups/:id/people")
      return {
        people: [
          { id: "owner", name: "Carla", avatarSeed: "carla", role: "admin" },
          { id: "ana", name: "Ana", avatarSeed: "ana", role: "member" },
        ],
      }
    if (route === "GET /browser/tabs")
      return {
        tabs: [
          {
            tabId: "work-tab",
            ownerBotId: bot.id,
            url: "https://estadias.example.test/busca",
            title: "Estadias fictícias",
            state: "live",
            openerTabId: null,
            heldByUser: held,
            lastUsedAt: now,
          },
        ],
      }
    if (route === "GET /bots/:id/browser-preview")
      return { image, title: "Estadias fictícias", url: "https://estadias.example.test/busca" }
    if (route === "GET /attachments/:id/content")
      return {
        text: JSON.stringify({ content: [{ type: "image", mimeType: "image/png", data: image.split(",")[1] }] }),
        bytes: image.length,
        offset: 0,
        nextOffset: null,
      }
    if (route === "GET /runs")
      return { runs: finished ? [run, Object.assign({}, run, { id: "resumed-run", browserRequestId: run.id })] : [run] }
    if (route === "GET /threads/:id/runs" && params?.id === thread.id)
      return { runs: finished ? [run, Object.assign({}, run, { id: "resumed-run", browserRequestId: run.id })] : [run] }
    const response = await request(route, body, params, transport)
    if (route === "GET /workspace/activity") return Object.assign({}, response, { browserRuns: [browserRun] })

    return response
  }) as ApiRequest
}

const getSyntheticPage = (): string => {
  const canvas = document.createElement("canvas")
  canvas.width = 800
  canvas.height = 500
  const context = canvas.getContext("2d")
  if (!context) throw new Error("Missing synthetic preview canvas")
  context.fillStyle = "#ffffff"
  context.fillRect(0, 0, 800, 500)
  context.fillStyle = "#c2410c"
  context.font = "bold 28px sans-serif"
  context.fillText("Estadias · dados fictícios", 32, 55)
  context.fillStyle = "#18181b"
  context.font = "22px sans-serif"
  context.fillText("Chicago · 10 a 14 de novembro", 32, 112)
  context.fillText("Estadia Lago    9,4    US$ 848 total", 32, 210)
  context.fillText("Estadia Centro  9,2    US$ 920 total", 32, 300)

  return canvas.toDataURL("image/png")
}
