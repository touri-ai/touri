import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import type { ApiRoutes, Message, Run } from "@touri/contracts"
import { afterEach, describe, expect, it, vi } from "vitest"
import App from "../src/App"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { latestPreview } from "../src/botPreview"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { MachineFields } from "../src/components/MachineFields"
import { ApiError } from "../src/errors"
import { machineStateForDisplay } from "../src/machineState"
import { useWorkspace } from "../src/useWorkspace"
import { readWorkspaceState } from "../src/workspaceState"
import { showBotSettings } from "./workspaceNavigation"

const originalReveal = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView")
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (originalReveal) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalReveal)
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView")
})

const message = (patch: Partial<Message> = {}): Message => ({
  id: "reply",
  threadId: "thread-mark",
  parentId: null,
  role: "assistant",
  kind: "text",
  status: "complete",
  runId: null,
  text: "Resposta",
  parts: [],
  sender: null,
  source: "local",
  createdAt: 1,
  updatedAt: 1,
  ...patch,
})

const scrollGeometry = (height = 1800) => {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(height)
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400)
}

describe("R6: conversa em uso", () => {
  it("prefers a running conversation over a remembered idle conversation when returning to a bot", async () => {
    const api = createMockApi()
    const runningThread = (await api.request("POST /threads", { botId: "bot-mark", title: "Em andamento" })).thread
    const { result } = renderHook(() => useWorkspace(api))
    await waitFor(() => expect(result.current.data.loading).toBe(false))
    await act(async () => {
      result.current.actions.selectThread("thread-mark")
      api.emit({
        type: "run.updated",
        run: {
          id: "background-run",
          botId: "bot-mark",
          threadId: runningThread.id,
          provider: "codex",
          trigger: "user",
          status: "running",
          routineRunId: null,
          requestMessageId: null,
          replyMessageId: null,
          externalTurnId: null,
          errorClass: null,
          errorMessage: null,
          usage: null,
          queuedAt: 2,
          startedAt: 3,
          finishedAt: null,
        },
      })
    })
    await act(async () => result.current.actions.selectBot("bot-onb"))
    await act(async () => result.current.actions.selectBot("bot-mark"))
    expect(result.current.data.selectedThreadId).toBe(runningThread.id)
    await act(async () => result.current.actions.selectThread("thread-mark"))
    await act(async () => result.current.actions.selectLocation({ bot: "bot-onb", thread: null }))
    await act(async () => result.current.actions.selectLocation({ bot: "bot-mark", thread: null }))
    expect(result.current.data.selectedThreadId).toBe(runningThread.id)
  })

  it("opens the most recent private conversation without a saved selection, independent of server order", async () => {
    const api = createMockApi()
    const newest = (await api.request("POST /threads", { botId: "bot-mark", title: "Mais recente" })).thread
    newest.updatedAt += 1000
    const request = api.request
    const client = {
      ...api,
      request: (async (route, input, path) => {
        const response = await request(route, input, path)
        if (route === "GET /bots/:id/threads") {
          const { threads } = response as ApiRoutes["GET /bots/:id/threads"]["res"]
          return { threads: [...threads].sort((a, b) => a.updatedAt - b.updatedAt) }
        }
        return response
      }) as ApiRequest,
    }
    const { result } = renderHook(() => useWorkspace(client))
    await waitFor(() => expect(result.current.data.loading).toBe(false))
    expect(result.current.data.selectedThreadId).toBe(newest.id)
  })

  it("returns to the selected thread even while another bot is open and the thread is running", async () => {
    const api = createMockApi()
    const { result } = renderHook(() => useWorkspace(api))
    await waitFor(() => expect(result.current.data.loading).toBe(false))
    await act(() => result.current.actions.createThread())
    const selected = result.current.data.selectedThreadId
    vi.useFakeTimers()
    await act(() => result.current.actions.sendMessage("Trabalhe nesta conversa"))
    expect(result.current.data.runs.some((run) => run.threadId === selected && run.status === "queued")).toBe(true)
    act(() => result.current.actions.selectBot("bot-onb"))
    act(() => result.current.actions.selectBot("bot-mark"))
    expect(result.current.data.selectedThreadId).toBe(selected)
    act(() => result.current.actions.selectLocation({ bot: "bot-onb", thread: null }))
    act(() => result.current.actions.selectLocation({ bot: "bot-mark", thread: null }))
    expect(result.current.data.selectedThreadId).toBe(selected)
    await act(() => vi.runAllTimersAsync())
    expect(result.current.data.runs.some((run) => run.threadId === selected && run.status === "succeeded")).toBe(true)
  })

  it("remembers each bot across remounts and rejects a thread belonging to another bot", async () => {
    const api = createMockApi()
    const first = renderHook(() => useWorkspace(api))
    await waitFor(() => expect(first.result.current.data.loading).toBe(false))
    await act(() => first.result.current.actions.createThread())
    const selected = first.result.current.data.selectedThreadId
    act(() => first.result.current.actions.selectBot("bot-onb"))
    first.unmount()
    const next = renderHook(() => useWorkspace(api))
    await waitFor(() => expect(next.result.current.data.loading).toBe(false))
    act(() => next.result.current.actions.selectBot("bot-mark"))
    expect(next.result.current.data.selectedThreadId).toBe(selected)
    next.unmount()
    localStorage.setItem("touri.workspace.v1", JSON.stringify({ threadsByBot: { "bot-mark": "thread-onb" } }))
    const invalid = renderHook(() => useWorkspace(api))
    await waitFor(() => expect(invalid.result.current.data.loading).toBe(false))
    act(() => invalid.result.current.actions.selectBot("bot-mark"))
    expect(invalid.result.current.data.selectedThreadId).toBe(selected)
    expect(readWorkspaceState().threadId).toBe(selected)
  })

  it("honors an explicit thread link and keeps that selection after reloading data", async () => {
    const api = createMockApi()
    const { result } = renderHook(() => useWorkspace(api))
    await waitFor(() => expect(result.current.data.loading).toBe(false))
    await act(() => result.current.actions.createThread())
    const selected = result.current.data.selectedThreadId
    act(() => result.current.actions.selectLocation({ bot: "bot-onb", thread: "thread-mark" }))
    expect(result.current.data.selectedBotId).toBe("bot-mark")
    expect(result.current.data.selectedThreadId).toBe("thread-mark")
    act(() => result.current.actions.selectThread(selected ?? ""))
    await act(() => result.current.actions.refresh())
    act(() => result.current.actions.selectBot("bot-onb"))
    act(() => result.current.actions.selectBot("bot-mark"))
    expect(result.current.data.selectedThreadId).toBe(selected)
  })
})

describe("R6: novo turno visível", () => {
  it.each(["branch", "settings"])("scrolls to a sent turn after %s", async (change) => {
    scrollGeometry()
    const api = createMockApi()
    const request = api.request
    const client = {
      ...api,
      request: (async (route, input, path) => {
        const response = await request(route, input, path)
        if (route === "POST /threads/:id/messages") {
          const result = response as ApiRoutes["POST /threads/:id/messages"]["res"]
          const thread = api.getState().threads.find((thread) => thread.id === result.message.threadId)
          if (thread)
            api.emit({ type: "thread.updated", thread: { ...thread, activeLeafId: result.run.replyMessageId } })
        }
        return response
      }) as ApiRequest,
    }
    render(<App kernel={{ services: { api: client } }} />)
    const composer = await screen.findByRole("textbox", { name: "Mensagem para mark" })
    if (change === "branch") {
      const sibling = message({ id: "branch", text: "Outra resposta" })
      act(() => api.emit({ type: "message.created", message: sibling }))
      const next = screen
        .getAllByRole("button", { name: "Próxima ramificação" })
        .find((button) => !(button as HTMLButtonElement).disabled)
      if (!next) throw new Error("missing branch control")
      fireEvent.click(next)
      await waitFor(() => expect(api.calls.some((call) => call.route === "PATCH /threads/:id")).toBe(true))
    } else {
      showBotSettings()
      fireEvent.click(screen.getByRole("button", { name: "Salvar configurações" }))
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    }
    const list = screen.getByTestId("virtual-message-list")
    list.scrollTop = 0
    fireEvent.scroll(list)
    fireEvent.change(composer, { target: { value: "Mostre o novo turno" } })
    fireEvent.keyDown(composer, { key: "Enter" })
    await waitFor(() => expect(composer).toHaveValue(""))
    await waitFor(() => {
      expect(within(list).getByText("Mostre o novo turno")).toBeVisible()
      expect(list.scrollTop).toBe(1400)
    })
  })

  it("renders the latest turn in a virtualized history and preserves manual reading during deltas", () => {
    scrollGeometry(1201 * 158)
    const history = Array.from({ length: 1200 }, (_, index) => message({ id: `m-${index}`, createdAt: index }))
    const props = { onSwitchBranch: vi.fn(), onRetry: vi.fn(async () => {}) }
    const view = render(<VirtualMessageList {...props} messages={history} />)
    const list = screen.getByTestId("virtual-message-list")
    list.scrollTop = 0
    fireEvent.scroll(list)
    const turn = message({ id: "new-user", role: "user", text: "Novo turno", createdAt: 1201 })
    view.rerender(<VirtualMessageList {...props} messages={[...history, turn]} />)
    expect(screen.getByText("Novo turno")).toBeVisible()
    expect(list.querySelectorAll("article").length).toBeLessThan(60)
    list.scrollTop = 0
    fireEvent.scroll(list)
    view.rerender(
      <VirtualMessageList {...props} messages={[...history, turn, message({ id: "delta", createdAt: 1202 })]} />,
    )
    expect(list.scrollTop).toBe(0)
  })

  it("keeps the latest virtualized turn rendered when tall replies exceed the estimated row height", () => {
    scrollGeometry(200_000)
    const history = Array.from({ length: 200 }, (_, index) => message({ id: `m-${index}`, createdAt: index }))
    const turn = message({ id: "new-user", role: "user", text: "Último turno", createdAt: 201 })
    render(
      <VirtualMessageList messages={[...history, turn]} onSwitchBranch={vi.fn()} onRetry={vi.fn(async () => {})} />,
    )
    expect(screen.getByText("Último turno")).toBeVisible()
    expect(screen.getByTestId("virtual-message-list").querySelectorAll("article").length).toBeLessThan(60)
  })

  it("follows delayed message layout while preserving manual history reading and disconnects on unmount", () => {
    const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1800)
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400)
    let resized: (() => void) | undefined
    const disconnect = vi.fn()
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resized = callback
        }
        observe = vi.fn()
        disconnect = disconnect
      },
    )
    const view = render(
      <VirtualMessageList messages={[message()]} onSwitchBranch={vi.fn()} onRetry={vi.fn(async () => {})} />,
    )
    const list = screen.getByTestId("virtual-message-list")
    expect(list.scrollTop).toBe(1400)
    height.mockReturnValue(2500)
    act(() => resized?.())
    expect(list.scrollTop).toBe(2100)
    list.scrollTop = 0
    fireEvent.scroll(list)
    height.mockReturnValue(3000)
    act(() => resized?.())
    expect(list.scrollTop).toBe(0)
    view.unmount()
    expect(disconnect).toHaveBeenCalledOnce()
  })
})

describe("R6: cancelamento e confirmação", () => {
  it.each(["canceled: Error: Turno cancelado", "A operação foi cancelada. [TOURI-E1007]", "Cancelado por você"])(
    "hides a neutral cancellation from machine errors: %s",
    (error) => {
      expect(
        machineStateForDisplay({
          botId: "qa",
          status: "error",
          error,
          progress: "Cancelado por você",
          memoryMb: 2048,
          createdMs: null,
          startMs: null,
        }),
      ).toMatchObject({ status: "stopped", error: null })
    },
  )

  it("preserves partial output and presents user cancellation without an error or retry action", () => {
    render(
      <VirtualMessageList
        messages={[
          message({
            status: "canceled",
            text: "Trabalho já realizado",
            parts: [{ type: "notice", code: "run_canceled", level: "warning", text: "canceled: Turno cancelado" }],
          }),
        ]}
        onSwitchBranch={vi.fn()}
        onRetry={vi.fn(async () => {})}
      />,
    )
    expect(screen.getByText("Cancelado por você")).toBeVisible()
    expect(screen.getByText("Trabalho já realizado")).toBeVisible()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.queryByRole("button", { name: "Tentar novamente" })).toBeNull()
    expect(document.body).not.toHaveTextContent(/canceled:|Turno cancelado/)
  })

  it("preserves VM failures and running progress while hiding a previous cancellation", () => {
    const failed = {
      botId: "qa",
      status: "error" as const,
      progress: null,
      error: "Xvfb não iniciou",
      memoryMb: 2048,
      createdMs: null,
      startMs: null,
    }
    expect(machineStateForDisplay(failed)).toEqual(failed)
    expect(
      machineStateForDisplay({
        ...failed,
        status: "starting",
        progress: "Iniciando…",
        error: "Error: Turno cancelado",
      }),
    ).toMatchObject({ status: "starting", progress: "Iniciando…", error: null })
  })
  it("shows Cancelado in the sidebar for legacy cancel notices", () => {
    const canceled = message({
      status: "canceled",
      text: "",
      parts: [{ type: "notice", code: "run_canceled", level: "warning", text: "canceled: Turno cancelado" }],
    })
    expect(latestPreview({ threadIds: [canceled.threadId], messages: [canceled] })).toBe("Cancelado por você")
  })

  it("hides the idle machine header and explains a legacy turn cancellation in settings", async () => {
    const api = createMockApi()
    await api.request("PATCH /bots/:id", { machine: "vm" }, { id: "bot-mark" })
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    act(() =>
      api.emit({
        type: "machine.updated",
        machine: {
          botId: "bot-mark",
          status: "error",
          progress: null,
          error: "Error: Turno cancelado",
          memoryMb: 2048,
          createdMs: null,
          startMs: null,
        },
      }),
    )
    const header = document.querySelector(".machine-turn-status")
    expect(header).toBeNull()
    showBotSettings()
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }),
    )
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("tab", { name: "Computador" }))
    const settings = screen.getByRole("region", { name: "Computador" })
    expect(settings).toHaveTextContent("O computador está parado")
    expect(settings).not.toHaveTextContent("Cancelado")
    expect(settings).not.toHaveTextContent(/Erro anterior|Error:|Turno cancelado/)
  })

  it("uses Cancelado for a canceled routine without displaying its transport error", async () => {
    const api = createMockApi()
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    const canceled: Run = {
      id: "routine-cancel",
      botId: "bot-mark",
      threadId: "thread-mark",
      provider: "codex",
      trigger: "routine",
      routineRunId: "routine-run",
      status: "canceled",
      requestMessageId: null,
      replyMessageId: null,
      externalTurnId: null,
      errorClass: "canceled",
      errorMessage: "Error: Turno cancelado",
      usage: null,
      queuedAt: Date.now(),
      startedAt: null,
      finishedAt: Date.now(),
    }
    act(() => api.emit({ type: "run.updated", run: canceled }))
    expect(document.querySelector(".run-card")).toHaveTextContent("Cancelado por você")
    expect(document.querySelector(".run-card")).not.toHaveClass("run-failed")
    expect(document.querySelector(".run-card .run-status")).not.toHaveClass("status-failed")
    expect(document.querySelector(".run-card")).not.toHaveTextContent(/Error:|canceled:|Turno cancelado/)
  })

  it.each([true, false])("reveals and focuses restart confirmation (active turns: %s)", async (activeTurns) => {
    const reveal = vi.fn()
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: reveal })
    const action = activeTurns ? vi.fn(async () => {}) : vi.fn().mockRejectedValue(new ApiError(409, "Máquina ocupada"))
    render(
      <MachineFields
        values={{ machine: "vm", machineIdleMinutes: 15, vmProviderLogin: false, hostComputerUse: false }}
        provider="codex"
        activeTurns={activeTurns}
        onChange={vi.fn()}
        onAction={action}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Atualizar o computador do Bot" }))
    const confirmation = await screen.findByRole("alertdialog")
    await waitFor(() => expect(reveal.mock.contexts).toContain(confirmation))
    expect(within(confirmation).getByRole("button", { name: "Cancelar" })).toHaveFocus()
    expect(action).toHaveBeenCalledTimes(activeTurns ? 0 : 1)
  })
})

describe("R6: integrações e Preview/Logs", () => {
  it.each(["mark", "onb"])("names %s and opens its MCP section with focus", async (name) => {
    const reveal = vi.fn()
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: reveal })
    const api = createMockApi()
    const botId = `bot-${name}`
    localStorage.setItem("touri.workspace.v1", JSON.stringify({ botId }))
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: `Mensagem para ${name}` })
    fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
    fireEvent.click(screen.getByRole("button", { name: /Integrações/ }))
    const configureMcp = await screen.findByRole("button", { name: `Configurar MCP de ${name}` })

    await act(async () => fireEvent.click(configureMcp))
    const mcp = await screen.findByRole("region", { name: "Servidores MCP deste bot" })
    await waitFor(() => {
      expect(reveal.mock.contexts).toContain(mcp)
      expect(mcp).toHaveFocus()
    })
    expect(api.calls.some((call) => call.route === "GET /bots/:id/mcp" && call.pathValues.id === botId)).toBe(true)
  })

  it("uses one empty-preview instruction and a contextual Logs header", async () => {
    const api = createMockApi()
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    if (!screen.queryByRole("button", { name: "Preview do projeto" }))
      fireEvent.click(screen.getByRole("button", { name: "Painel do bot" }))
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Preview do projeto" })))
    await screen.findByRole("heading", { name: "Preview", exact: true })

    const preview = document.querySelector(".preview-main-pane")
    expect(preview).not.toBeNull()
    expect(screen.getAllByText(/Inicie um processo.*HTTP/i)).toHaveLength(1)
    await act(async () => fireEvent.click(screen.getByRole("tab", { name: "Logs" })))
    const heading = document.querySelector(".preview-log-toolbar")
    expect(screen.getByRole("combobox", { name: "Processo dos logs" })).toBeVisible()
    expect(heading).not.toHaveTextContent(/renderizado ao vivo|porta HTTP/)
    expect(screen.queryByText(/Inicie um processo.*HTTP/i)).toBeNull()
    act(() =>
      api.emit({
        type: "preview.available",
        preview: {
          projectId: "project-demo",
          processId: "web",
          port: 3000,
          url: "http://localhost:3000",
          label: "Demo",
        },
      }),
    )
    expect(screen.getByRole("combobox", { name: "Processo dos logs" })).toBeVisible()
    expect(heading).not.toHaveTextContent("renderizado ao vivo")
    fireEvent.click(screen.getByRole("tab", { name: "Navegador" }))
    expect(screen.getByRole("heading", { name: "Navegador" })).toBeVisible()
    expect(document.querySelector(".preview-log-toolbar")).toBeNull()
  })
})
