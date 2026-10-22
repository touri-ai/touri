import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { Message, ToolCallPart } from "@touri/contracts"
import { afterEach, expect, test, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { InlinePreviewContext } from "../src/features/desktop/InlineLivePreview"

afterEach(cleanup)

test("control and private input survive the assistant finishing its waiting reply", async () => {
  const api = createMockApi()
  const bot = api.getState().bots[0]
  if (!bot) throw new Error("Missing fixture bot")
  const tool: ToolCallPart = {
    type: "tool_call",
    callId: "handoff",
    tool: "browser_request_takeover",
    summary: "login",
    inputJson: '{"tabId":"tab","reason":"login"}',
    outputJson: '{"status":"waiting_for_person"}',
    ok: true,
  }
  const message: Message = {
    id: "reply",
    threadId: "thread",
    runId: "run",
    parentId: null,
    role: "assistant",
    kind: "text",
    status: "streaming",
    text: "Entre no site para continuar.",
    parts: [tool, { type: "text", text: "Entre no site para continuar." }],
    sender: { id: bot.id, name: "Léo" },
    source: "local",
    createdAt: 1,
    updatedAt: 2,
  }
  const request = vi.fn(async (route: string, body?: { viewEpoch?: number }) => {
    if (route === "GET /browser/tabs")
      return { tabs: [{ tabId: "tab", ownerBotId: bot.id, state: "live", heldByUser: true, takeoverRunId: "run" }] }
    if (route === "POST /browser/tabs/:id/takeover/session")
      return { sessionId: "session", controlEpoch: "control", viewEpoch: 0 }
    if (route === "POST /browser/tabs/:id/takeover/frame")
      return {
        targetEpoch: 1,
        viewEpoch: body?.viewEpoch ?? 0,
        width: 800,
        height: 500,
        title: "",
        url: "",
        image: "data:image/png;base64,ZmFrZQ==",
      }
    return {}
  }) as ApiRequest
  const boundApi = Object.assign({}, api, { request })
  const getView = (reply: Message) => (
    <InlinePreviewContext.Provider
      value={{ api: boundApi, bot, machine: undefined, activeCallId: undefined, onOpenComputer: vi.fn() }}
    >
      <VirtualMessageList messages={[reply]} onSwitchBranch={vi.fn()} onRetry={async () => {}} />
    </InlinePreviewContext.Provider>
  )
  const view = render(getView(message))
  fireEvent.click(await screen.findByRole("button", { name: "Assumir", exact: true }))
  await screen.findByRole("button", { name: "Devolver para Léo" })

  view.rerender(getView(Object.assign({}, message, { status: "complete" as const })))

  expect(await screen.findByRole("button", { name: "Devolver para Léo" })).toBeVisible()
  const image = await screen.findByRole("img", { name: "Página atual do navegador" })
  fireEvent.load(image)
  const keyboard = screen.getByRole("textbox", { name: "Entrada de teclado para o navegador" })
  fireEvent.input(keyboard, { target: { value: "entrada privada fictícia" } })
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "POST /browser/tabs/:id/takeover/input",
      expect.objectContaining({ sessionId: "session", input: { kind: "text", text: "entrada privada fictícia" } }),
      { id: "tab" },
    ),
  )
  expect(document.body.textContent).not.toContain("entrada privada fictícia")
  expect(document.querySelectorAll(".browser-activity-card")).toHaveLength(1)
  fireEvent.click(screen.getByRole("button", { name: "Devolver para Léo" }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "DELETE /browser/tabs/:id/takeover/session",
      { sessionId: "session", controlEpoch: "control" },
      { id: "tab" },
    ),
  )
})

test("an expired handoff is visibly incomplete when the saved reply is reopened", async () => {
  const message: Message = {
    id: "expired-reply",
    threadId: "thread",
    runId: "run",
    parentId: null,
    role: "assistant",
    kind: "text",
    status: "complete",
    text: "Aguardando você entrar no site.",
    parts: [
      {
        type: "tool_call",
        callId: "wait",
        tool: "browser_request_takeover",
        summary: "login",
        inputJson: '{"tabId":"tab"}',
        outputJson: '{"status":"waiting_for_person"}',
        ok: true,
      },
      { type: "text", text: "Aguardando você entrar no site." },
      {
        type: "notice",
        level: "warning",
        code: "run_failed",
        text: "No one took over in time. Ask again when you can.",
      },
    ],
    sender: { id: "leo", name: "Léo" },
    source: "local",
    createdAt: 1,
    updatedAt: 2,
  }

  render(<VirtualMessageList messages={[message]} onSwitchBranch={vi.fn()} onRetry={async () => {}} />)

  expect(screen.getByText("não concluído", { exact: true })).toBeVisible()
  expect(screen.getByText("Ninguém assumiu a tempo. Peça de novo quando puder.")).toBeVisible()
  expect(screen.queryByText("concluído", { exact: true })).toBeNull()
})
