import type { Message, SendMessageInput } from "@touri/contracts"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { apiRouteKeys, createApiClient, webEndpoint } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import "../../src/styles.css"

declare global {
  interface Window {
    connectionRecovery: {
      setServerAvailable: (available: boolean) => void
      setSessionAccepted: (accepted: boolean) => void
      getSends: () => SendMessageInput[]
      getRequests: () => number
      getPending: () => Message[]
    }
  }
}

const mock = createMockApi()
const state = mock.getState()
const bot = state.bots.find((candidate) => candidate.id === "bot-mark")
const thread = state.threads.find((candidate) => candidate.id === "thread-mark")
const baseMessage = state.messages.find((candidate) => candidate.threadId === thread?.id)
if (!bot || !thread || !baseMessage) throw new Error("Missing synthetic connection fixture")
const history: Message = Object.assign({}, baseMessage, {
  id: "connection-history",
  parentId: null,
  role: "user" as const,
  runId: null,
  text: "Histórico de teste preservado.",
  parts: [{ type: "text" as const, text: "Histórico de teste preservado." }],
})

// These maps model the external server and record only bounded synthetic transport requests.
const server = new Map<string, boolean>([
  ["available", true],
  ["session", true],
])
const messages = new Map<string, Message>([[history.id, history]])
const sends = new Map<number, SendMessageInput>()
const requests = new Map<number, string>()
const getRoute = (method: string, pathname: string) =>
  apiRouteKeys.find((route) => {
    const [verb, path] = route.split(" ")
    if (verb !== method || !path) return false

    return new RegExp(`^/api/v1${path.replace(/:[a-zA-Z]+/g, "[^/]+")}$`).test(pathname)
  })

const api = createApiClient({
  endpoint: webEndpoint(window.location),
  fetchImpl: async (input, init) => {
    const url = new URL(String(input), location.origin)
    requests.set(requests.size, url.pathname)
    if (!server.get("available")) throw new TypeError("Synthetic server unavailable")
    if (!server.get("session")) return Response.json({ errorCode: "UNAUTHORIZED" }, { status: 401 })
    if (url.pathname.endsWith("/ws-ticket")) return Response.json({ ticket: "synthetic-ticket" })
    if (url.pathname.endsWith("/health")) return Response.json({ ok: true, schemaVersion: 46, protocolVersion: 1 })
    if (/\/threads\/[^/]+\/runs$/.test(url.pathname)) return Response.json({ runs: [] })

    const route = getRoute(init?.method ?? "GET", url.pathname)
    if (!route) throw new Error("Unexpected synthetic request")
    if (route === "GET /bots") return Response.json({ bots: [Object.assign({}, bot, { paused: false })] })
    if (route === "GET /runs") return Response.json({ runs: [] })
    if (route === "GET /bots/:id/threads")
      return Response.json({
        threads: [Object.assign({}, thread, { activeLeafId: Array.from(messages.keys()).at(-1) })],
      })
    if (route === "GET /threads/:id/messages")
      return Response.json({
        messages: Array.from(messages.values()),
        activeLeafId: Array.from(messages.keys()).at(-1),
      })
    if (route === "POST /threads/:id/messages") {
      const sent = JSON.parse(String(init?.body)) as SendMessageInput
      sends.set(sends.size, sent)
      const message: Message = Object.assign({}, history, {
        id: `send:${sent.clientNonce}`,
        parentId: sent.parentId,
        text: sent.text,
        parts: [{ type: "text" as const, text: sent.text }],
        delivery: { clientNonce: sent.clientNonce, deadline: sent.deadline, status: "acked" as const },
      })
      messages.set(message.id, message)
      return Response.json({ message, run: null })
    }

    const path = route.split(" ")[1]?.split("/") ?? []
    const values = url.pathname.replace("/api/v1", "").split("/")
    const pathValues = Object.fromEntries(
      path.flatMap((segment, index) => (segment.startsWith(":") ? [[segment.slice(1), values[index] ?? ""]] : [])),
    )
    const body = init?.body ? JSON.parse(String(init.body)) : Object.fromEntries(url.searchParams)
    return Response.json(await mock.request(route, body, pathValues))
  },
})

Object.assign(window, {
  connectionRecovery: {
    setServerAvailable: (available: boolean) => server.set("available", available),
    setSessionAccepted: (accepted: boolean) => server.set("session", accepted),
    getSends: () => Array.from(sends.values()),
    getRequests: () => requests.size,
    getPending: () => api.pendingMessages?.() ?? [],
  },
})
localStorage.setItem("touri.workspace.v1", JSON.stringify({ botId: bot.id, threadId: thread.id }))
const root = document.getElementById("root")
if (!root) throw new Error("Missing connection fixture root")
createRoot(root).render(<App kernel={{ services: { api } }} />)
