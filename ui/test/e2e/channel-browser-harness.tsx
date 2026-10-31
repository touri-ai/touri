import type { Bot, BotGroup, Message, ToolCallPart } from "@touri/contracts"
import { useEffect, useMemo, useState } from "react"
import { createRoot } from "react-dom/client"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { GroupHeader, GroupSidebar } from "../../src/components/Groups"
import { TurnActivity } from "../../src/components/TurnActivity"
import { ChannelBrowserContext, ChannelComposerChip } from "../../src/features/channelBrowser/ChannelBrowser"
import type { ChannelBrowserState } from "../../src/features/channelBrowser/channelBrowserModel"
import { InlinePreviewContext } from "../../src/features/desktop/InlineLivePreview"
import { changeMockBrowserControl } from "./channel-browser-request"
import "../../src/styles.css"

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get("theme") ?? "dark"
const viewerId = params.get("viewer") ?? "user-ana"
const tookOver = params.get("takeover") === "1"
const queued = params.get("queue") === "1"

const getPreview = (): string => {
  const canvas = document.createElement("canvas")
  canvas.width = 800
  canvas.height = 500
  const context = canvas.getContext("2d")
  if (!context) return ""
  context.fillStyle = "#ffffff"
  context.fillRect(0, 0, 800, 500)
  context.fillStyle = "#c2410c"
  context.font = "bold 26px sans-serif"
  context.fillText("estadias", 40, 60)
  context.strokeStyle = "#d4d4d8"
  context.strokeRect(40, 90, 440, 48)
  context.strokeRect(500, 90, 260, 48)
  context.fillStyle = "#1d1d20"
  context.font = "22px sans-serif"
  context.fillText("Chicago, Illinois", 56, 122)
  context.fillText("10 nov – …", 516, 122)

  return canvas.toDataURL("image/png")
}

const state: ChannelBrowserState = {
  status: params.has("workflow") ? "needs_you" : "running",
  botId: "bot-leo",
  botName: "Léo",
  requesterId: "user-ana",
  requesterName: "Ana",
  controllerId: tookOver ? "user-ana" : null,
  controllerName: tookOver ? "Ana" : null,
  ownerId: "user-owner",
  queue: queued ? [{ requesterId: "user-hugo", requesterName: "Hugo" }] : [],
}

const getPart = (callId: string, tool: string, input: Record<string, unknown>): ToolCallPart => ({
  type: "tool_call",
  callId,
  tool: `mcp__touri__${tool}`,
  summary: tool,
  inputJson: JSON.stringify(input),
  outputJson: JSON.stringify({ structured: { tabId: "tab-1" } }),
  startedAt: Date.now(),
  resolvedAt: Date.now(),
  ok: true,
})

const parts = [
  getPart("open", "browser_open", { url: "https://estadias.example.test/busca" }),
  getPart("type", "browser_type", { tabId: "tab-1", target: { name: "Destino" } }),
  getPart("click", "browser_click", { tabId: "tab-1", target: { name: "Chicago, Illinois" } }),
]

const Fixture = () => {
  const [liveState, setLiveState] = useState(state)
  const transport = useMemo(() => new BroadcastChannel("browser-card-demo"), [])
  const api = useMemo(() => createMockApi(), [])
  const preview = useMemo(getPreview, [])
  const isHeld = liveState.status === "needs_you" || Boolean(liveState.controllerId)

  useEffect(() => {
    const update = (next: ChannelBrowserState) => setLiveState(next)
    transport.onmessage = (event: MessageEvent<ChannelBrowserState>) => update(event.data)

    return () => transport.close()
  }, [transport])

  useEffect(() => {
    api.emit({
      type: "browser.tab",
      tab: {
        tabId: "tab-1",
        ownerBotId: "bot-mark",
        url: "https://estadias.example.test/busca",
        title: "Estadias",
        state: "live",
        openerTabId: null,
        heldByUser: isHeld,
        takeoverReason: "login",
        lastUsedAt: Date.now(),
      },
    })
  }, [api, isHeld])

  const changeControl = (controllerId: string | null): void => {
    const next = Object.assign({}, liveState, {
      status: controllerId ? ("taken_over" as const) : ("running" as const),
      controllerId,
      controllerName: controllerId ? "Ana" : null,
    })
    setLiveState(next)
    transport.postMessage(next)
  }
  api.request = (async (route: string, input?: unknown) => {
    if (route === "POST /browser/tabs/:id/takeover/session") {
      await changeMockBrowserControl(() => changeControl("user-ana"))
      return { sessionId: "demo-session", controlEpoch: "demo-control", viewEpoch: 0 }
    }
    if (route === "DELETE /browser/tabs/:id/takeover/session") {
      await changeMockBrowserControl(() => changeControl(null))
      return {}
    }
    if (route === "POST /browser/tabs/:id/takeover/input") return {}
    if (route === "POST /browser/tabs/:id/takeover/frame")
      return {
        image: preview,
        title: "Estadias",
        url: "https://estadias.example.test/busca",
        width: 800,
        height: 500,
        controlEpoch: "demo-control",
        targetEpoch: 1,
        viewEpoch: (input as { viewEpoch?: number } | undefined)?.viewEpoch ?? 0,
      }
    if (route === "GET /browser/tabs")
      return {
        tabs: [
          {
            tabId: "tab-1",
            ownerBotId: "bot-mark",
            url: "https://estadias.example.test/busca",
            title: "Estadias",
            state: "live",
            openerTabId: null,
            heldByUser: isHeld,
            takeoverReason: "login",
            lastUsedAt: Date.now(),
          },
        ],
      }
    if (route === "GET /bots/:id/browser-preview")
      return { image: preview, title: "Estadias", url: "https://estadias.example.test/busca" }

    return {}
  }) as ApiRequest
  const bots = api.getState().bots.slice(0, 2) as Bot[]
  const bot = bots[0] ?? null
  const group = {
    id: "group-viagens",
    name: "viagens",
    color: "#dc2626",
    avatarShape: "classic-none",
    avatarSeed: "viagens",
    memberIds: bots.map((item) => item.id),
    coordinatorBotId: null,
  } as unknown as BotGroup
  const message = {
    id: "reply",
    threadId: "thread",
    parentId: null,
    role: "assistant",
    kind: "text",
    status: "streaming",
    runId: null,
    text: "",
    parts,
    sender: { name: "Léo", id: "bot-leo" },
    source: "local",
    createdAt: Date.now() - 1_000,
    updatedAt: Date.now(),
  } satisfies Message

  return (
    <ChannelBrowserContext.Provider value={{ state: liveState, viewerId }}>
      <div className="channel-demo">
        <GroupSidebar
          groups={[group]}
          threads={[]}
          selectedThreadId={null}
          onSelect={() => {}}
          onCreate={() => {}}
          onEdit={() => {}}
          onNewThread={() => {}}
          channelWorking={{ [group.id]: ["Léo"] }}
        />
        <main className="channel-demo-main">
          <GroupHeader group={group} bots={bots} onEdit={() => {}} channelMode={params.has("channelMode")} />
          <InlinePreviewContext.Provider
            value={{ api, bot, machine: undefined, activeCallId: undefined, onOpenComputer: () => {} }}
          >
            <div className="channel-demo-reply" data-message-id="reply">
              <div className="message-meta">
                <strong>Léo</strong> · respondendo à Ana · em andamento
              </div>
              <p>Abri a busca. Agora vou escolher as datas da viagem.</p>
              <TurnActivity message={message} api={api} state="working-tool" />
            </div>
          </InlinePreviewContext.Provider>
          <ChannelComposerChip botName="Léo" onStop={() => {}} />
        </main>
      </div>
    </ChannelBrowserContext.Provider>
  )
}

const root = document.getElementById("root")
if (root) createRoot(root).render(<Fixture />)
