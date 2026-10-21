import type { BrowserTabInfo, Message, Run } from "@touri/contracts"
import { useEffect, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import type { ApiRequest } from "../../../src/api/client"
import { createMockApi } from "../../../src/api/mock"
import { ChatPanel } from "../../../src/components/ChatPanel"
import "../../../src/styles.css"
import type { FlowSnapshot } from "./scripted-bot"

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get("theme") ?? "dark"
const TAB_ID = "cu-fixture-tab"
const startedAt = Date.now() - 2_000

type FlowWindow = Window & {
  cuFlow?: { publish: (snapshot: FlowSnapshot) => void; isHeld: () => boolean; sent: () => string[] }
}

const getFixture = () => {
  const api = createMockApi()
  const bot = api.getState().bots.find((item) => item.id === "bot-mark")
  const thread = api.getState().threads.find((item) => item.id === "thread-mark")
  if (!bot || !thread) throw new Error("Fixture bot is missing")

  return { api, bot: { ...bot, name: "Léo" }, thread }
}

const Flow = () => {
  const [fixture] = useState(getFixture)
  const [snapshot, setSnapshot] = useState<FlowSnapshot>({ parts: [], running: true })
  const [held, setHeld] = useState(false)
  const [sent, setSent] = useState<string[]>([])
  const latest = useRef({ snapshot, held, sent })
  latest.current = { snapshot, held, sent }
  const { api, bot, thread } = fixture

  useEffect(() => {
    const baseRequest = api.request
    api.request = (async (route: string, input?: unknown, pathValues: Record<string, string> = {}) => {
      const preview = latest.current.snapshot.preview
      if (route === "GET /browser/tabs")
        return {
          tabs: [
            {
              tabId: TAB_ID,
              ownerBotId: bot.id,
              url: preview?.url ?? "about:blank",
              title: preview?.title ?? "",
              state: "live",
              openerTabId: null,
              heldByUser: latest.current.held,
              lastUsedAt: Date.now(),
            } satisfies BrowserTabInfo & { ownerBotId: string },
          ],
        }
      if (route === "POST /browser/tabs/:id/takeover") {
        setHeld((input as { hold: boolean }).hold)
        return {}
      }
      if (route === "POST /browser/tabs/:id/takeover/session") {
        setHeld(true)
        return { sessionId: "computer-use-flow-session", controlEpoch: "computer-use-control", viewEpoch: 0 }
      }
      if (route === "POST /browser/tabs/:id/takeover/frame")
        return {
          controlEpoch: "computer-use-control",
          targetEpoch: 1,
          viewEpoch: (input as { viewEpoch: number }).viewEpoch,
          title: preview?.title ?? "Página de teste",
          url: preview?.url ?? "https://estadias.exemplo/entrar",
          image: preview?.preview ?? "",
          width: 1280,
          height: 720,
        }
      if (route === "POST /browser/tabs/:id/takeover/input") return {}
      if (route === "DELETE /browser/tabs/:id/takeover/session") {
        setHeld(false)
        return {}
      }
      if (route === "GET /bots/:id/browser-preview") return preview ?? {}
      if (route === "GET /attachments/:id/content") return { text: "", offset: 0, nextOffset: null, bytes: 0 }

      return baseRequest(route as Parameters<ApiRequest>[0], input as never, pathValues)
    }) as ApiRequest
    const flowWindow = window as FlowWindow
    flowWindow.cuFlow = {
      publish: setSnapshot,
      isHeld: () => latest.current.held,
      sent: () => latest.current.sent,
    }

    return () => {
      delete flowWindow.cuFlow
    }
  }, [api, bot.id])

  const { question, reply, run } = useMemo(() => {
    const question: Message = {
      id: "cu-question",
      threadId: thread.id,
      parentId: null,
      role: "user",
      kind: "text",
      status: "complete",
      runId: null,
      text: "Busca estadias em Chicago de 10 a 14 de novembro e me lista as 4 melhores, com nota e preço total.",
      parts: [
        {
          type: "text",
          text: "Busca estadias em Chicago de 10 a 14 de novembro e me lista as 4 melhores, com nota e preço total.",
        },
      ],
      sender: null,
      source: "local",
      createdAt: startedAt - 1_000,
      updatedAt: startedAt - 1_000,
    }
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

    return { question, reply, run }
  }, [snapshot, thread, bot])

  return (
    <ChatPanel
      thread={{ ...thread, activeLeafId: reply.id }}
      bot={bot}
      messages={[question, reply]}
      runs={[run]}
      onSend={async (text) => setSent((previous) => [...previous, text])}
      onRetry={async () => undefined}
      onCancel={async () => undefined}
      onSwitchBranch={async () => undefined}
      computerGrant={null}
      api={api}
      onComputerGrant={() => undefined}
      onOpenTools={() => undefined}
    />
  )
}

const root = document.getElementById("root")
if (root) createRoot(root).render(<Flow />)
