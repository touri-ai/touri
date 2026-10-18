import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import type { ApiRoutes } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import type { UiApi } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { ActivityMark } from "../src/components/ActivityMark"
import { getQueueLabel } from "../src/features/work/presentation"
import { PerformanceScreen, WorkScreen } from "../src/features/work/WorkScreen"
import { useWorkspace } from "../src/useWorkspace"
import { createWorkApi } from "./fixtures/work-api"

afterEach(cleanup)

it("lists every executing and queued turn, origins and engine positions, and opens its conversation", async () => {
  const api = createWorkApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para Planejamento" })

  const badge = screen.getByRole("button", { name: "Ver trabalho: 3 em execução, 2 na fila", exact: true })
  expect(badge).toBeVisible()
  expect(badge).toHaveTextContent("Trabalhando 3")
  expect(badge).toHaveTextContent("2 na fila")

  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  fireEvent.click(screen.getByRole("button", { name: "Trabalho", exact: true }))

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
  await screen.findByRole("button", { name: "Bots 5" })

  act(() => {
    api.finishFirst()
    release()
  })
  await screen.findByRole("textbox", { name: "Mensagem para Planejamento" })
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  fireEvent.click(screen.getByRole("button", { name: "Trabalho", exact: true }))

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

it("saves the concurrency limit through Advanced and restores its saved value", async () => {
  const api = createWorkApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para Planejamento" })

  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  fireEvent.click(screen.getByRole("button", { name: "Desempenho", exact: true }))
  const input = await screen.findByRole("spinbutton", { name: "Tarefas ao mesmo tempo" })
  expect(input).toHaveValue(3)
  fireEvent.change(input, { target: { value: "4" } })
  fireEvent.click(screen.getByRole("button", { name: "Salvar limite" }))
  await screen.findByText("Limite salvo.")

  expect(api.calls).toContainEqual({ route: "PATCH /settings", input: { maxConcurrentRuns: 4 }, pathValues: {} })
  expect((await api.request("GET /settings", {})).settings.maxConcurrentRuns).toBe(4)

  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  fireEvent.click(screen.getByRole("button", { name: "Trabalho", exact: true }))
  expect(await screen.findByRole("heading", { name: "Trabalho", exact: true })).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
  fireEvent.click(screen.getByRole("button", { name: "Desempenho", exact: true }))
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
