import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import type { ApiRoutes } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import type { UiApi } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { ActivityMark } from "../src/components/ActivityMark"
import { GroupPanel } from "../src/components/GroupPanel"
import { getQueuedWorkRuns, getQueueLabel } from "../src/features/work/presentation"
import { PerformanceScreen, WorkScreen } from "../src/features/work/WorkScreen"
import { useWorkspace } from "../src/useWorkspace"
import { getGroupProgressFixture } from "./fixtures/groupProgress"
import { createWorkApi } from "./fixtures/work-api"
import { openGlobalPage, openWork } from "./workspaceNavigation"

afterEach(cleanup)

it("lists every executing and queued turn, origins and engine positions, and opens its conversation", async () => {
  const api = createWorkApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para Planejamento" })

  expect(document.querySelector(".sidebar-work-badge")).toBeNull()

  openWork()

  const running = await screen.findByRole("region", { name: "Trabalhando", exact: true })
  const queued = screen.getByRole("region", { name: "Na fila", exact: true })
  expect(within(running).getAllByRole("article")).toHaveLength(3)
  expect(within(queued).getAllByRole("article")).toHaveLength(2)
  expect(screen.getByText("Na fila · 1º de 2")).toBeVisible()
  expect(screen.getByText("Na fila · 2º de 2")).toBeVisible()
  expect(screen.getByText("Delegação")).toBeVisible()
  expect(screen.getByText("Retomada")).toBeVisible()
  expect(screen.getByText("Rotina")).toBeVisible()
  act(() => {
    api.finishFirst()
  })

  expect(within(running).getAllByRole("article")).toHaveLength(3)
  expect(within(queued).getAllByRole("article")).toHaveLength(1)
  expect(screen.getByText("Na fila · 1º de 1")).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Tarefa de organização" }))
  expect(await screen.findByRole("textbox", { name: "Mensagem para Organização" })).toBeVisible()
  expect(screen.getByText("Na fila · 1º de 1")).toBeVisible()
})

it("confirms a selected task stop without waiting for live events and preserves the queued request", async () => {
  const api = createWorkApi()
  const running = api.getRuns()[0]
  const queued = api.getRuns()[3]
  if (!running || !queued) throw new Error("Missing work fixture")
  const canceled = Object.assign({}, running, { status: "canceled" as const, finishedAt: Date.now() })
  const cancellation = vi.fn()
  const request: UiApi["request"] = async (route, input, path) => {
    if (route !== "POST /runs/:id/cancel") return api.request(route, input, path)

    cancellation(input, path)
    return { run: canceled } as ApiRoutes[typeof route]["res"]
  }
  const client = Object.assign({}, api, { request })
  render(<App kernel={{ services: { api: client } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para Planejamento" })
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  fireEvent.click(screen.getByRole("button", { name: "Trabalho", exact: true }))
  const stopButtons = await screen.findAllByRole("button", { name: "Parar só esta tarefa" })
  const firstStop = stopButtons[0]
  if (!firstStop) throw new Error("Missing task control")

  fireEvent.click(firstStop)

  await waitFor(() => expect(cancellation).toHaveBeenCalledWith({ scope: "turn" }, { id: running.id }))
  await waitFor(() => expect(document.querySelector(`[data-run-id="${running.id}"]`)).toBeNull())
  expect(document.querySelector(`[data-run-id="${queued.id}"]`)).toBeVisible()
})

it("shows stop failures and prevents duplicate requests while stopping", async () => {
  const api = createWorkApi()
  const stopped = Promise.withResolvers<void>()
  const onStop = vi.fn(() => stopped.promise)
  render(
    <WorkScreen
      runs={api.getRuns()}
      bots={api.bots}
      threads={api.threads}
      loading={false}
      onThread={vi.fn()}
      onStop={onStop}
    />,
  )
  const cancelButtons = screen.getAllByRole("button", { name: "Cancelar só este pedido" })
  const firstCancel = cancelButtons[0]
  if (!firstCancel) throw new Error("Missing waiting request")

  fireEvent.click(firstCancel)

  expect(screen.getByRole("button", { name: "Parando…" })).toBeDisabled()
  expect(
    screen.getAllByRole("button", { name: "Parar só esta tarefa" }).every((button) => button.hasAttribute("disabled")),
  ).toBe(true)
  await act(async () => stopped.reject(new Error("Synthetic failure")))
  expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível parar a tarefa. Tente novamente.")
  expect(
    screen
      .getAllByRole("button", { name: "Cancelar só este pedido" })
      .every((button) => !button.hasAttribute("disabled")),
  ).toBe(true)
  expect(onStop).toHaveBeenCalledTimes(1)
})

it("keeps a confirmed stop newer than a workspace snapshot without live events", async () => {
  const api = createWorkApi()
  const running = api.getRuns()[0]
  if (!running) throw new Error("Missing work fixture")
  const canceled = Object.assign({}, running, { status: "canceled" as const, finishedAt: Date.now() })
  const requested = Promise.withResolvers<void>()
  const snapshot = Promise.withResolvers<void>()
  let delayRuns = false
  const request: UiApi["request"] = async (route, input, path) => {
    if (route === "POST /runs/:id/cancel") return { run: canceled } as ApiRoutes[typeof route]["res"]

    const response = await api.request(route, input, path)
    if (route === "GET /runs" && delayRuns) {
      requested.resolve()
      await snapshot.promise
    }

    return response
  }
  const client = Object.assign({}, api, { request })
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  delayRuns = true

  await act(async () => {
    const refreshed = hook.result.current.actions.refresh()
    await requested.promise
    await hook.result.current.actions.cancelRun(running.id, "turn")
    snapshot.resolve()
    await refreshed
  })

  expect(hook.result.current.data.workRuns.some((run) => run.id === running.id)).toBe(false)
  expect(hook.result.current.data.runs.find((run) => run.id === running.id)?.status).toBe("canceled")
})

it("opens the visible group while the work run retains its execution thread", () => {
  const api = createWorkApi()
  const run = api.getRuns()[0]
  const thread = api.threads[0]
  if (!run || !thread) throw new Error("Missing work fixture")
  const onThread = vi.fn()
  render(
    <WorkScreen
      runs={[{ ...run, threadId: "hidden-worker", groupThreadId: thread.id }]}
      bots={api.bots}
      threads={[thread]}
      loading={false}
      onThread={onThread}
    />,
  )

  fireEvent.click(screen.getByRole("button", { name: "Tarefa de planejamento" }))

  expect(onThread).toHaveBeenCalledWith(thread.id)
})

it("keeps completion events newer than an in-flight global snapshot", async () => {
  const api = createWorkApi()
  let release = () => {}
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const request: UiApi["request"] = async (route, input, path) => {
    const response = await api.request(route, input, path)
    if (route === "GET /runs") await waiting
    return response
  }
  render(<App kernel={{ services: { api: { ...api, request } } }} />)
  await screen.findByRole("tab", { name: /^Bots, \d+ aguardando$/ })

  act(() => {
    api.finishFirst()
    release()
  })
  await screen.findByRole("textbox", { name: "Mensagem para Planejamento" })
  openWork()

  await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(4))
  expect(document.querySelector('[data-run-id="work-run-0"]')).toBeNull()
  expect(screen.getByText("Na fila · 1º de 1")).toBeVisible()
})

it("keeps an admitted turn out of the queue when its acceptance arrives after a live update", async () => {
  const api = createMockApi()
  const template = createWorkApi().getRuns()[4]
  const message = api.getState().messages[0]
  if (!template || !message) throw new Error("Missing mock turn")
  const accepted = { ...template, id: "late-acceptance", botId: "bot-mark", threadId: "thread-mark" }
  const request: UiApi["request"] = async (route, input, path) => {
    if (route !== "POST /threads/:id/messages") return api.request(route, input, path)
    api.emit({ type: "run.updated", run: { ...accepted, status: "starting", queuePosition: null, queueTotal: null } })
    return {
      run: accepted,
      message: { ...message, id: "accepted-message", role: "user" },
    } as ApiRoutes[typeof route]["res"]
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))

  await act(async () => {
    await hook.result.current.actions.sendMessage("Tarefa de demonstração")
  })

  expect(hook.result.current.data.runs.find((run) => run.id === accepted.id)).toMatchObject({
    status: "starting",
    queuePosition: null,
    queueTotal: null,
  })
})

it("keeps the latest queue position when an opened conversation loads an older snapshot", async () => {
  const api = createWorkApi()
  let requested = false
  let release = () => {}
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const request: UiApi["request"] = async (route, input, path) => {
    const response = await api.request(route, input, path)
    if (route === "GET /threads/:id/runs" && path?.id === "work-thread-4") {
      requested = true
      await waiting
    }
    return response
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  act(() => {
    hook.result.current.actions.selectThread("work-thread-4")
  })
  await waitFor(() => expect(requested).toBe(true))

  await act(async () => {
    api.finishFirst()
    release()
    await waiting
  })

  await waitFor(() =>
    expect(hook.result.current.data.runs.find((run) => run.id === "work-run-4")).toMatchObject({
      status: "queued",
      queuePosition: 1,
      queueTotal: 1,
    }),
  )
})

it("shows queue positions in Portuguese and English and uses the slot fallback without engine metadata", () => {
  const api = createWorkApi()
  const queued = api.getRuns()[3]
  if (!queued) throw new Error("Missing queued turn")

  const view = render(<ActivityMark state="thinking" run={queued} />)

  expect(screen.getByRole("status")).toHaveTextContent("Na fila · 1º de 2")
  expect(getQueueLabel(queued, "en")).toBe("Queued · 1 of 2")
  view.rerender(<ActivityMark state="thinking" run={{ ...queued, queuePosition: null, queueTotal: null }} />)
  expect(screen.getByRole("status")).toHaveTextContent("Na fila · aguardando uma vaga")
})

it("keeps a waiting channel request visible and removes its placeholder when an execution starts", async () => {
  const api = createWorkApi()
  const template = api.getRuns()[3]
  if (!template) throw new Error("Missing queued turn")
  const waiting = { ...template, id: "channel-request", kind: "coordination" as const }
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))

  act(() => api.emit({ type: "run.updated", run: waiting }))

  expect(hook.result.current.data.workRuns.find((run) => run.id === waiting.id)).toMatchObject(waiting)
  expect(getQueueLabel(waiting)).toBe("Na fila · aguardando o bot concluir o pedido anterior")
  expect(getQueueLabel(waiting, "en")).toBe("Queued · waiting for the bot to finish the previous request")

  act(() => {
    api.emit({ type: "run.updated", run: { ...waiting, status: "running" } })
    api.emit({
      type: "run.updated",
      run: { ...waiting, id: "channel-execution", groupTurnId: waiting.id, kind: "execution", status: "starting" },
    })
  })

  expect(hook.result.current.data.workRuns.some((run) => run.id === waiting.id)).toBe(false)
  expect(hook.result.current.data.workRuns.find((run) => run.id === "channel-execution")).toMatchObject({
    kind: "execution",
    status: "starting",
    groupTurnId: waiting.id,
  })
})

it("saves the concurrency limit through Advanced and restores its saved value", async () => {
  const api = createWorkApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para Planejamento" })

  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  openGlobalPage("Desempenho")
  const input = await screen.findByRole("spinbutton", { name: "Tarefas ao mesmo tempo" })
  expect(input).toHaveValue(3)
  fireEvent.change(input, { target: { value: "4" } })
  fireEvent.click(screen.getByRole("button", { name: "Salvar limite" }))
  await screen.findByText("Limite salvo.")

  expect(api.calls).toContainEqual({ route: "PATCH /settings", input: { maxConcurrentRuns: 4 }, pathValues: {} })
  expect((await api.request("GET /settings", {})).settings.maxConcurrentRuns).toBe(4)

  openWork()
  expect(await screen.findByRole("heading", { name: "Trabalho", exact: true })).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  openGlobalPage("Desempenho")
  expect(await screen.findByRole("spinbutton", { name: "Tarefas ao mesmo tempo" })).toHaveValue(4)
})

it("keeps a failed save actionable and shows a calm empty work view", async () => {
  const api = createWorkApi()
  const settings = (await api.request("GET /settings", {})).settings
  const save = vi.fn().mockRejectedValue(new Error("offline"))
  const view = render(<PerformanceScreen settings={settings} onSave={save} />)

  fireEvent.click(screen.getByRole("button", { name: "Salvar limite" }))

  expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível salvar.")
  expect(screen.getByRole("button", { name: "Salvar limite" })).toBeEnabled()
  view.rerender(<WorkScreen runs={[]} bots={[]} threads={[]} loading={false} onThread={() => {}} />)
  expect(screen.getByText(/Nenhuma tarefa em execução ou na fila/)).toBeVisible()
})

it("projects each pending bot's queue while another recipient of the same message is running", () => {
  const api = createWorkApi()
  const template = api.getRuns()[0]
  const first = api.bots[0]
  const second = api.bots[1]
  if (!template || !first || !second) throw new Error("Missing bot queue fixtures")
  const partial = { ...template, id: "partial", kind: "coordination" as const, pendingBotIds: [second.id] }
  const later = {
    ...partial,
    id: "later",
    status: "queued" as const,
    pendingBotIds: [first.id, second.id],
    queuedAt: partial.queuedAt + 1,
  }
  const runs = [partial, later, { ...template, id: "execution" }]

  render(<WorkScreen runs={runs} bots={api.bots} threads={api.threads} loading={false} onThread={vi.fn()} />)

  const queued = screen.getByRole("region", { name: "Na fila", exact: true })
  expect(within(queued).getAllByRole("article")).toHaveLength(3)
  expect(within(queued).getAllByText(second.name)).toHaveLength(2)
  expect(within(queued).getByText(first.name)).toBeVisible()
  expect(screen.getByText("Na fila deste bot · 2º de 2")).toBeVisible()
  expect(screen.getByRole("region", { name: "Trabalhando", exact: true }).querySelectorAll("article")).toHaveLength(1)
  const projected = getQueuedWorkRuns(runs)
  expect(projected.map(({ botId, queuePosition, queueTotal }) => ({ botId, queuePosition, queueTotal }))).toEqual([
    { botId: second.id, queuePosition: 1, queueTotal: 2 },
    { botId: first.id, queuePosition: 1, queueTotal: 1 },
    { botId: second.id, queuePosition: 2, queueTotal: 2 },
  ])
  expect(getQueueLabel(projected[2] ?? template, "en", "bot")).toBe("In this bot's queue · 2 of 2")
})

it("keeps partially admitted channel recipients in the task list until their own executions start", async () => {
  const api = createWorkApi()
  const template = api.getRuns()[0]
  if (!template) throw new Error("Missing work fixture")
  const partial = { ...template, id: "partial", kind: "coordination" as const, pendingBotIds: [template.botId] }
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))

  act(() => api.emit({ type: "run.updated", run: partial }))

  expect(hook.result.current.data.workRuns.find((run) => run.id === partial.id)?.pendingBotIds).toEqual([
    template.botId,
  ])
  act(() => api.emit({ type: "run.updated", run: { ...partial, pendingBotIds: [] } }))
  expect(hook.result.current.data.workRuns.some((run) => run.id === partial.id)).toBe(false)
})

it("does not restore pending bots from a work snapshot older than their admission event", async () => {
  const api = createWorkApi()
  const template = api.getRuns()[0]
  if (!template) throw new Error("Missing work fixture")
  const partial = { ...template, id: "partial", kind: "coordination" as const, pendingBotIds: [template.botId] }
  const requested = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let delay = false
  const request: UiApi["request"] = async (route, input, path) => {
    if (route !== "GET /runs" || !delay) return api.request(route, input, path)

    requested.resolve()
    await release.promise
    return { runs: [partial], draining: false } as ApiRoutes[typeof route]["res"]
  }
  const client = { ...api, request }
  const hook = renderHook(() => useWorkspace(client))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  act(() => api.emit({ type: "run.updated", run: partial }))
  delay = true

  await act(async () => {
    const refresh = hook.result.current.actions.refresh()
    await requested.promise
    api.emit({ type: "run.updated", run: { ...partial, pendingBotIds: [] } })
    release.resolve()
    await refresh
  })

  expect(hook.result.current.data.workRuns.some((run) => run.id === partial.id)).toBe(false)
})

it("shows each member's waiting count in the channel panel without counting a working peer", () => {
  const fixture = getGroupProgressFixture()
  const peer = fixture.bots[1]
  if (!peer) throw new Error("Missing teammate")
  const partial = { ...fixture.coordination, pendingBotIds: [peer.id] }

  render(
    <GroupPanel
      group={fixture.group}
      bots={fixture.bots}
      threadId={fixture.thread.id}
      runs={[partial, fixture.execution]}
      onClose={vi.fn()}
      onEdit={vi.fn()}
      channelMode
    />,
  )

  const rows = screen.getAllByRole("listitem")
  const waiting = rows.find((row) => within(row).queryByText(peer.name))
  const working = rows.find((row) => within(row).queryByText(fixture.bot.name))
  if (!waiting || !working) throw new Error("Missing member rows")
  expect(within(waiting).getByText("Pedidos na fila deste bot: 1")).toBeVisible()
  expect(within(working).queryByText(/Pedidos na fila/)).toBeNull()
})
