import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import type { ApiRoutes, Bot, Message, RoutineRun, Run } from "@touri/contracts"
import { afterEach, describe, expect, it, vi } from "vitest"
import App from "../src/App"
import { type ApiRequest, createApiClient } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import CronScreen from "../src/components/CronScreen"
import { MachineFields } from "../src/components/MachineFields"
import { BotCreateModal, BotSettingsModal } from "../src/components/Modals"
import { ApiError, userFacingError } from "../src/errors"
import { t, threadTitle } from "../src/i18n"
import { useWorkspace, type WorkspaceActions } from "../src/useWorkspace"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("r4 P0/P1 recovery", () => {
  it("keeps Cancelado visible when the cancel response arrives after the completion event", async () => {
    const api = createMockApi()
    let completeRequest: ((response: { run: Run }) => void) | undefined
    const pending = new Promise<{ run: Run }>((resolve) => {
      completeRequest = resolve
    })
    const request = api.request
    const client = {
      ...api,
      request: ((route, input, path) =>
        route === "POST /runs/:id/cancel" ? pending : request(route, input, path)) as ApiRequest,
    }
    render(<App kernel={{ services: { api: client } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    const running: Run = {
      id: "cancel-run",
      botId: "bot-mark",
      threadId: "thread-mark",
      provider: "codex",
      trigger: "user",
      status: "starting",
      routineRunId: null,
      requestMessageId: null,
      replyMessageId: null,
      externalTurnId: null,
      errorClass: null,
      errorMessage: null,
      usage: null,
      queuedAt: Date.now(),
      startedAt: Date.now(),
      finishedAt: null,
    }
    act(() => api.emit({ type: "run.updated", run: running }))
    fireEvent.click(screen.getByRole("button", { name: "Parar" }))
    expect(screen.getByRole("button", { name: "Parando…" })).toBeDisabled()
    const reply: Message = {
      id: "canceled-reply",
      threadId: running.threadId,
      parentId: null,
      role: "assistant",
      kind: "text",
      status: "canceled",
      runId: running.id,
      text: "",
      parts: [{ type: "notice", code: "run_canceled", level: "warning", text: "canceled: Turno cancelado" }],
      sender: null,
      source: "local",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await act(async () => {
      api.emit({ type: "message.created", message: reply })
      const thread = api.getState().threads.find((thread) => thread.id === running.threadId)
      if (!thread) throw new Error("missing thread")
      api.emit({ type: "thread.updated", thread: { ...thread, activeLeafId: reply.id } })
      api.emit({ type: "run.updated", run: { ...running, status: "canceled", finishedAt: Date.now() } })
      completeRequest?.({ run: running })
      await pending
    })
    expect(document.querySelector(".run-status")).toHaveTextContent("Cancelado")
    expect(document.querySelector('[data-bot-entry="bot-mark"] .bot-preview')).toHaveTextContent("Cancelado")
    expect(screen.queryByRole("button", { name: "Parar" })).toBeNull()
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled()
  })
  it("offers cancellation and restart during VM bootstrap, and only sends it after confirmation", async () => {
    const action = vi.fn(async () => {})
    render(
      <MachineFields
        values={{ machine: "vm", machineIdleMinutes: 15, vmProviderLogin: true, hostComputerUse: false }}
        provider="codex"
        activeTurns
        state={{
          botId: "qa",
          status: "starting",
          progress: "Preparando máquina…",
          error: null,
          memoryMb: 2048,
          createdMs: null,
          startMs: null,
        }}
        onChange={vi.fn()}
        onAction={action}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Atualizar o computador do Bot" }))
    const dialog = screen.getByRole("alertdialog")
    expect(action).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }))
    expect(action).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Atualizar o computador do Bot" }))
    fireEvent.click(screen.getByRole("button", { name: "Parar turnos e reiniciar" }))
    await waitFor(() => expect(action).toHaveBeenCalledExactlyOnceWith(false, true))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
  })

  it("recovers from a busy-machine response even if the UI missed the running event", async () => {
    const action = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, "Error: Máquina ocupada; pare os turnos antes de reiniciar"))
      .mockResolvedValueOnce(undefined)
    render(
      <MachineFields
        values={{ machine: "vm", machineIdleMinutes: 15, vmProviderLogin: false, hostComputerUse: false }}
        provider="codex"
        onChange={vi.fn()}
        onAction={action}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Atualizar o computador do Bot" }))
    await screen.findByRole("alertdialog")
    expect(screen.queryByText(/sidecar request failed/)).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Parar turnos e reiniciar" }))
    await waitFor(() => expect(action).toHaveBeenLastCalledWith(false, true))
  })

  it.each([400, 401, 409, 500, 503])("keeps HTTP %i metadata and strips raw transport prefixes", async (status) => {
    const api = createApiClient({
      endpoint: { baseUrl: "http://localhost", wsUrl: "ws://localhost", token: "test" },
      fetchImpl: vi.fn(async () =>
        Response.json(
          {
            error: `Error: sidecar request failed: ${status} · Error: Não foi possível preparar a máquina`,
            errorCode: "MACHINE_ERROR",
          },
          { status },
        ),
      ),
    })
    const error = await api.request("POST /bots/:id/machine/restart", {}, { id: "qa" }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status, errorCode: "MACHINE_ERROR", message: "Não foi possível preparar a máquina" })
    expect(userFacingError(`Error: sidecar request failed: ${status} · Error: detalhe`)).toBe("detalhe")
  })

  it.each(["succeeded", "failed", "canceled"] as const)(
    "re-enables Rodar agora on %s, including a completion event before the POST response",
    async (status) => {
      const api = createMockApi()
      const routine = (await api.request("GET /routines", {})).routines[0]
      if (!routine) throw new Error("missing routine")
      let completeRequest: ((response: { routineRun: RoutineRun }) => void) | undefined
      const pending = new Promise<{ routineRun: RoutineRun }>((resolve) => {
        completeRequest = resolve
      })
      const request = vi.fn(api.request)
      const client = {
        ...api,
        request: ((route, input, path) =>
          route === "POST /routines/:id/run" ? pending : request(route, input, path)) as ApiRequest,
      }
      const running: RoutineRun = {
        id: "r4-run",
        routineId: routine.id,
        runId: "turn",
        threadId: "thread-mark",
        status: "running",
        scheduledFor: Date.now(),
        triggerSource: "manual",
        summary: null,
        startedAt: Date.now(),
        finishedAt: null,
      }
      const View = () => {
        const { data, actions } = useWorkspace(client)
        return <CronScreen {...data} actions={actions} onReviewApprovals={vi.fn()} onNotice={vi.fn()} />
      }
      render(<View />)
      const button = await screen.findByRole("button", { name: `Rodar agora ${routine.name}` })
      fireEvent.click(button)
      expect(button).toBeDisabled()
      await act(async () => {
        api.emit({ type: "routine.updated", routine, lastRun: { ...running, status, finishedAt: Date.now() } })
        completeRequest?.({ routineRun: running })
        await pending
      })
      await waitFor(() => expect(button).toBeEnabled())
      expect(request.mock.calls.filter(([route]) => route === "GET /routine-runs")).toHaveLength(1)
    },
  )

  it("renders pending approvals in a body portal and sends explicit Aprovar/Negar decisions", async () => {
    const api = createMockApi()
    const view = render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    for (const [label, behavior] of [
      ["Aprovar", "allow"],
      ["Negar", "deny"],
    ] as const) {
      act(() => {
        api.notify({
          kind: "approval",
          title: "Aprovar comando",
          body: "gh pr list — revisar a execução pendente",
          botId: "bot-mark",
          requestId: `approval-${behavior}`,
        })
      })
      fireEvent.click(screen.getByRole("button", { name: "Notificações, 1 precisa de atenção" }))
      const center = screen.getByRole("region", { name: "Central de notificações" })
      expect(center.closest(".motion-presence")?.parentElement).toBe(document.body)
      expect(view.container.contains(center)).toBe(false)
      expect(within(center).getByRole("button", { name: "Aprovar" })).toBeVisible()
      expect(within(center).getByRole("button", { name: "Negar" })).toBeVisible()
      expect(
        api.calls.some(
          (call) =>
            call.route === "POST /threads/:id/respond" && JSON.stringify(call.input).includes(`approval-${behavior}`),
        ),
      ).toBe(false)
      fireEvent.click(within(center).getByRole("button", { name: label }))
      await waitFor(() =>
        expect(
          api.calls.some(
            (call) =>
              call.route === "POST /threads/:id/respond" &&
              JSON.stringify(call.input).includes(`"behavior":"${behavior}"`),
          ),
        ).toBe(true),
      )
      fireEvent.click(screen.getByRole("button", { name: "Notificações" }))
    }
  })
})

describe("r4 workflow polish", () => {
  it("offers a complete new-bot configuration in one dialog", async () => {
    const create = vi.fn(async (_input: ApiRoutes["POST /bots"]["req"]) => {})
    render(
      <BotCreateModal
        onClose={vi.fn()}
        onCreate={create}
        projects={[{ id: "project", name: "Touri" } as ApiRoutes["GET /projects"]["res"]["projects"][number]]}
      />,
    )
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "qa" } })
    fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
    fireEvent.change(screen.getByLabelText("Instruções do bot"), { target: { value: "Leia o projeto." } })
    fireEvent.change(screen.getByLabelText("Modelo", { selector: "input" }), { target: { value: "gpt-6.1-sol" } })
    fireEvent.change(screen.getByLabelText("Raciocínio"), { target: { value: "high" } })
    fireEvent.change(screen.getByLabelText("Projeto", { selector: "select" }), { target: { value: "project" } })
    fireEvent.click(screen.getByRole("button", { name: "Criar bot" }))
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          instructions: "Leia o projeto.",
          model: "gpt-6.1-sol",
          reasoningEffort: "high",
          projectId: "project",
          browserEnabled: true,
        }),
      ),
    )
  })

  it("resets model, reasoning and provider login guidance on a provider switch", async () => {
    const api = createMockApi()
    const bot = {
      ...api.getState().bots[0],
      machine: "vm",
      provider: "claude",
      model: "claude-opus",
      reasoningEffort: "high",
    } as Bot
    const original = api.request
    const request = vi.fn((route, input, path) =>
      route === "GET /bots/:id/provider-login/flow"
        ? Promise.resolve({ provider: input.provider, state: "idle" })
        : route === "POST /bots/:id/provider-login/flow"
          ? Promise.resolve({ provider: input.provider, state: "waiting" })
          : original(route, input, path),
    )
    api.request = request as ApiRequest
    render(
      <BotSettingsModal
        bot={bot}
        api={api}
        projects={[]}
        routines={[]}
        actions={{ updateBot: vi.fn() } as unknown as WorkspaceActions}
        onClose={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
    fireEvent.click(screen.getByRole("tab", { name: "Acesso" }))
    await screen.findByText("Aguardando login no navegador…")
    fireEvent.click(screen.getByRole("tab", { name: "Modelo" }))
    fireEvent.change(screen.getByLabelText("Provedor"), { target: { value: "codex" } })
    expect(screen.getByLabelText("Modelo", { selector: "input" })).toHaveValue("")
    expect(screen.getByLabelText("Raciocínio")).toHaveValue("")
    // The Access pane mounts on demand, so the new provider's login starts when it is shown.
    fireEvent.click(screen.getByRole("tab", { name: "Acesso" }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "POST /bots/:id/provider-login/flow",
        { provider: "codex", action: "start" },
        { id: bot.id },
      ),
    )
    expect(await screen.findByRole("button", { name: "Cancelar login" })).toBeEnabled()
  })

  it("opens Logs with the only process already selected", async () => {
    const api = createMockApi()
    const request = api.request
    const client = {
      ...api,
      request: (async (route, input, path) => {
        const response = await request(route, input, path)
        if (route === "GET /projects/:id/processes") {
          const result = response as ApiRoutes["GET /projects/:id/processes"]["res"]
          return { processes: result.processes.slice(0, 1) }
        }
        return response
      }) as ApiRequest,
    }
    render(<App kernel={{ services: { api: client } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    if (!screen.queryByRole("button", { name: "Preview do projeto" }))
      fireEvent.click(screen.getByRole("button", { name: "Painel do bot" }))
    fireEvent.click(screen.getByRole("button", { name: "Preview do projeto" }))
    await screen.findByText("web", { selector: "strong" })
    fireEvent.click(screen.getByRole("tab", { name: "Logs" }))
    await screen.findByText(/\[mock\] process is ready/)
    expect(api.calls.filter((call) => call.route === "GET /processes/:id/logs")).toHaveLength(1)
    expect(screen.queryByText("Selecione um processo para ver os logs.")).toBeNull()
  })

  it("restores the last bot/thread and screen on remount", async () => {
    const api = createMockApi()
    const target = (await api.request("POST /threads", { botId: "bot-onb", title: "Última conversa" })).thread
    const hook = renderHook(() => useWorkspace(api))
    await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
    act(() => hook.result.current.actions.selectThread(target.id))
    await waitFor(() => expect(hook.result.current.data.selectedThreadId).toBe(target.id))
    hook.unmount()
    const first = render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para onb" })
    if (!screen.queryByRole("button", { name: "Preview do projeto" }))
      fireEvent.click(screen.getByRole("button", { name: "Painel do bot" }))
    fireEvent.click(screen.getByRole("button", { name: "Preview do projeto" }))
    first.unmount()
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("tab", { name: "Logs" })
    expect(screen.getByRole("button", { name: /Última conversa/ })).toHaveClass("selected")
  })

  it("uses Portuguese plurals and localizes imported date titles", () => {
    expect(t("Tool count", { count: 1 })).toBe("1 chamada de ferramenta")
    expect(t("Tool count", { count: 2 })).toBe("2 chamadas de ferramenta")
    expect(t("Notifications need attention", { count: 1 })).toBe("Notificações, 1 precisa de atenção")
    expect(threadTitle("Oct 12, 8:00 PM", new Date(2026, 9, 12).getTime())).toMatch(/12.*out.*20:00/)
    expect(threadTitle("onb: fila de KYB · Oct 12, 8:00 PM", new Date(2026, 9, 12).getTime())).toMatch(
      /^onb: fila de KYB · 12.*out.*20:00/,
    )
    expect(threadTitle("Plano do projeto", Date.now())).toBe("Plano do projeto")
  })
})
