import type { ApiRoutes, BrowserChannelRun, Message, Run } from "@touri/contracts"
import type { ApiRequest, UiApi } from "../src/api/client"
import { createMockApi } from "../src/api/mock"

export const getChannelBrowserWorkspaceFixture = async ({
  viewerId = "owner",
  controllerId = null,
}: {
  viewerId?: string
  controllerId?: string | null
} = {}) => {
  const base = createMockApi()
  const storedBot = base.getState().bots.find((candidate) => candidate.id === "bot-mark")
  if (!storedBot) throw new Error("Missing synthetic browser bot")

  const bot = Object.assign({}, storedBot, { name: "Léo", responsiblePersonId: "owner", homeDir: "/synthetic/bot" })
  const { group, thread } = await base.request("POST /groups", {
    name: "Viagens",
    color: "#c2410c",
    avatarShape: "classic-none",
    memberIds: [bot.id],
    coordinatorBotId: null,
  })
  const now = Date.now()
  const prompt: Message = {
    id: "browser-prompt",
    threadId: thread.id,
    parentId: null,
    role: "user",
    kind: "text",
    status: "complete",
    runId: null,
    text: "Confira a página de demonstração.",
    parts: [{ type: "text", text: "Confira a página de demonstração." }],
    sender: { id: "person-requester", name: "Ana", kind: "person" },
    source: "local",
    createdAt: now - 2,
    updatedAt: now - 2,
  }
  const reply: Message = Object.assign({}, prompt, {
    id: "browser-reply",
    parentId: prompt.id,
    role: "assistant",
    status: "streaming",
    runId: "browser-run",
    text: "Estou conferindo a página de demonstração.",
    parts: [
      { type: "text", text: "Estou conferindo a página de demonstração." },
      {
        type: "tool_call",
        callId: "browser-read",
        tool: "browser_snapshot",
        summary: "Synthetic browser action",
        inputJson: '{"tabId":"channel-tab"}',
        outputJson: null,
        ok: null,
      },
    ],
    sender: { id: bot.id, name: bot.name },
    createdAt: now - 1,
    updatedAt: now - 1,
  })
  const run: Run = {
    id: "browser-run",
    botId: bot.id,
    threadId: thread.id,
    provider: bot.provider,
    trigger: "user",
    requestMessageId: prompt.id,
    replyMessageId: reply.id,
    externalTurnId: null,
    status: "running",
    errorClass: null,
    errorMessage: null,
    usage: null,
    routineRunId: null,
    queuedAt: now - 2,
    startedAt: now - 1,
    finishedAt: null,
  }
  const browserRun: BrowserChannelRun = {
    runId: run.id,
    groupId: group.id,
    threadId: thread.id,
    botId: bot.id,
    requesterPersonId: "person-requester",
    requesterName: "Ana",
    responsiblePersonId: "owner",
    controllerPersonId: controllerId,
    controllerName: controllerId ? "Carla" : null,
    status: controllerId ? "taken_over" : "running",
    queuePosition: null,
    queuedAt: now - 2,
    startedAt: now - 1,
    needsYouAt: null,
    escalatedAt: null,
    finishedAt: null,
  }
  const request: ApiRequest = async (route, input, path, transport) => {
    if (route === "GET /session")
      return {
        ok: true,
        kind: "device",
        person: { id: viewerId, name: "Pessoa de teste", email: null, avatarSeed: viewerId, role: "admin" },
      } as ApiRoutes[typeof route]["res"]
    if (route === "GET /bots") return { bots: [bot] } as ApiRoutes[typeof route]["res"]
    if (route === "GET /groups/:id/people")
      return {
        people: [
          { id: "owner", name: "Carla", avatarSeed: "carla", role: "admin" },
          { id: "person-requester", name: "Ana", avatarSeed: "ana", role: "member" },
          { id: "person-observer", name: "Bia", avatarSeed: "bia", role: "member" },
        ],
      } as ApiRoutes[typeof route]["res"]
    if (route === "GET /workspace/activity")
      return { messages: [reply], runs: [run], browserRuns: [browserRun] } as ApiRoutes[typeof route]["res"]
    if (route === "GET /runs") return { runs: [run] } as ApiRoutes[typeof route]["res"]
    if (route === "POST /runs/:id/cancel")
      return {
        run: Object.assign({}, run, { status: "canceled", finishedAt: Date.now() }),
      } as ApiRoutes[typeof route]["res"]
    if (route === "GET /threads/:id/runs" && path?.id === thread.id)
      return { runs: [run] } as ApiRoutes[typeof route]["res"]
    if (route === "GET /threads/:id/messages" && path?.id === thread.id)
      return { messages: [prompt, reply], activeLeafId: reply.id } as ApiRoutes[typeof route]["res"]
    if (route === "GET /browser/tabs")
      return {
        tabs: [
          {
            tabId: "channel-tab",
            ownerBotId: bot.id,
            url: "https://demo.example.test",
            title: "Página de demonstração",
            state: "live",
            openerTabId: null,
            heldByUser: controllerId !== null,
            lastUsedAt: now,
          },
        ],
        lastFailure: null,
      } as ApiRoutes[typeof route]["res"]
    if (route === "GET /bots/:id/browser-preview")
      return {
        title: "Página de demonstração",
        url: "https://demo.example.test",
        image:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
      } as ApiRoutes[typeof route]["res"]

    return base.request(route, input, path, transport)
  }
  const api: UiApi = Object.assign({}, base, { isMock: false, request })

  return { api, emit: base.emit, bot, group, thread, reply, run, browserRun }
}
