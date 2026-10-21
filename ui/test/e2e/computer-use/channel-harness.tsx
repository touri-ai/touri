import type { BrowserTabInfo, Message, Run } from "@touri/contracts"
import { useEffect, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import type { ApiRequest } from "../../../src/api/client"
import { createMockApi } from "../../../src/api/mock"
import { ChatPanel } from "../../../src/components/ChatPanel"
import "../../../src/styles.css"
import type { ChannelWindow } from "./channel-hub"
import {
  type ChannelState,
  canControl,
  getControlNotice,
  getHeaderChip,
  getInitialChannel,
  getNeedsYouTarget,
  getVisibleSnapshot,
  MEMBER_NAMES,
  type MemberId,
} from "./channel-state"

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get("theme") ?? "dark"
const viewer = (params.get("viewer") ?? "carla") as MemberId
const TAB_ID = "cu-fixture-tab"
const startedAt = Date.now() - 2_000
const REQUEST = "@Léo busca estadias em Chicago de 10 a 14 de novembro e lista as 4 melhores com nota e preço total."

const getFixture = () => {
  const api = createMockApi()
  const bot = api.getState().bots.find((item) => item.id === "bot-mark")
  const thread = api.getState().threads.find((item) => item.id === "thread-mark")
  if (!bot || !thread) throw new Error("Fixture bot is missing")

  return { api, bot: { ...bot, name: "Léo" }, thread }
}

const getHumanMessage = (id: string, who: MemberId, text: string, createdAt: number, threadId: string): Message => ({
  id,
  threadId,
  parentId: null,
  role: "user",
  kind: "text",
  status: "complete",
  runId: null,
  text,
  parts: [{ type: "text", text }],
  sender: { name: MEMBER_NAMES[who], id: `member-${who}` },
  source: "local",
  createdAt,
  updatedAt: createdAt,
})

const getNeedsYouLine = (state: ChannelState, now: number): string | null => {
  const target = getNeedsYouTarget(state, now)
  if (!target) return null
  if (state.controller) return null

  return target === viewer
    ? "Léo precisa de você: o site pediu login"
    : `Léo chamou ${MEMBER_NAMES[target]} para entrar no site`
}

const Channel = () => {
  const [fixture] = useState(getFixture)
  const [channel, setChannel] = useState({ state: getInitialChannel("ana", "carla"), now: Date.now() })
  const latest = useRef(channel)
  latest.current = channel
  const { api, bot, thread } = fixture
  const { state, now } = channel
  const snapshot = getVisibleSnapshot(state)
  const mayControl = canControl(state, viewer)

  useEffect(() => {
    api.request = (async (route: string) => {
      const current = getVisibleSnapshot(latest.current.state)
      if (route === "GET /browser/tabs")
        return {
          tabs: [
            {
              tabId: TAB_ID,
              ownerBotId: bot.id,
              url: current.preview?.url ?? "about:blank",
              title: current.preview?.title ?? "",
              state: "live",
              openerTabId: null,
              heldByUser: false,
              lastUsedAt: Date.now(),
            } satisfies BrowserTabInfo & { ownerBotId: string },
          ],
        }
      if (route === "GET /bots/:id/browser-preview") return current.preview ?? {}
      if (route === "GET /attachments/:id/content") return { text: "", offset: 0, nextOffset: null, bytes: 0 }

      return {}
    }) as ApiRequest
    const channelWindow = window as ChannelWindow
    channelWindow.cuChannel = { apply: setChannel }

    return () => {
      delete channelWindow.cuChannel
    }
  }, [api, bot.id])

  const { messages, run } = useMemo(() => {
    const earlier = getHumanMessage(
      "cu-earlier",
      "carla",
      "Ana, consegue ver hospedagem pro evento de novembro em Chicago?",
      startedAt - 2_000,
      thread.id,
    )
    const question = getHumanMessage("cu-question", state.requester, REQUEST, startedAt - 1_000, thread.id)
    const reply: Message = {
      id: "cu-reply",
      threadId: thread.id,
      parentId: question.id,
      role: "assistant",
      kind: "text",
      status: snapshot.running ? "streaming" : "complete",
      runId: "cu-run",
      text: "",
      parts: snapshot.finalText ? [...snapshot.parts, { type: "text", text: snapshot.finalText }] : snapshot.parts,
      sender: { name: bot.name, id: bot.id },
      source: "local",
      createdAt: startedAt,
      updatedAt: startedAt + snapshot.parts.length,
    }
    const run: Run = {
      id: "cu-run",
      threadId: thread.id,
      botId: bot.id,
      provider: "codex",
      trigger: "user",
      requestMessageId: question.id,
      replyMessageId: reply.id,
      externalTurnId: null,
      status: snapshot.running ? "running" : "succeeded",
      errorClass: null,
      errorMessage: null,
      usage: null,
      routineRunId: null,
      queuedAt: startedAt,
      startedAt,
      providerStartedAt: startedAt,
      finishedAt: snapshot.running ? null : startedAt + snapshot.parts.length,
    }

    return { messages: [earlier, question, reply], run }
  }, [snapshot, thread, bot, state.requester])

  const notice = getControlNotice(state, viewer)
  const needsYou = getNeedsYouLine(state, now)
  const act = (action: "takeover" | "handback" | "stop") => void (window as ChannelWindow).cuChannelAct?.(action)

  return (
    <div className="cu-channel" data-viewer={viewer}>
      <header className="cu-channel-header">
        <div>
          <strong># viagens</strong>
          <small>Carla, Ana, Hugo e Léo</small>
        </div>
        {snapshot.running && <span className="cu-channel-chip">{getHeaderChip(state, bot.name)}</span>}
        {snapshot.running && mayControl && (
          <span className="cu-channel-controls">
            {state.controller ? (
              <button type="button" onClick={() => act("handback")}>
                Devolver
              </button>
            ) : (
              <button type="button" onClick={() => act("takeover")}>
                Assumir
              </button>
            )}
            <button type="button" onClick={() => act("stop")}>
              Parar
            </button>
          </span>
        )}
      </header>
      {notice && (
        <p className="cu-channel-banner" role="status">
          {notice}
        </p>
      )}
      {state.controller && (
        <p className="cu-channel-banner" role="status">
          A prévia está oculta para o canal enquanto {MEMBER_NAMES[state.controller]} digita
        </p>
      )}
      {needsYou && (
        <p className="cu-channel-banner" role="alert">
          {needsYou}
        </p>
      )}
      {state.queue.length > 0 && (
        <p className="cu-channel-banner" role="status">
          Na fila do {bot.name}: {state.queue.map((member) => `pedido do ${MEMBER_NAMES[member]}`).join(", ")}
        </p>
      )}
      <div className="cu-channel-chat">
        <ChatPanel
          thread={{ ...thread, activeLeafId: "cu-reply" }}
          bot={bot}
          messages={messages}
          runs={[run]}
          onSend={(text) => (window as ChannelWindow).cuChannelSend?.(text) ?? Promise.resolve()}
          onRetry={async () => undefined}
          onCancel={async () => undefined}
          onSwitchBranch={async () => undefined}
          computerGrant={null}
          api={api}
          onComputerGrant={() => undefined}
          onOpenTools={() => undefined}
        />
      </div>
    </div>
  )
}

const root = document.getElementById("root")
if (root) createRoot(root).render(<Channel />)
