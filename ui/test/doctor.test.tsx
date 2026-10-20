import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import type { DoctorReport, Run } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import type { ApiRequest, UiApi } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { DoctorChecks } from "../src/features/doctor/DoctorChecks"
import { useDoctorReport } from "../src/features/doctor/useDoctorReport"
import { useWorkspace } from "../src/useWorkspace"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const report: DoctorReport = {
  running: false,
  checkedAt: 1234,
  checks: [
    { id: "network-openai-dns", label: "OpenAI · DNS", status: "pass", ok: true, detail: "DNS resolvido.", fix: null },
    {
      id: "codex",
      label: "codex · versão",
      status: "warn",
      ok: false,
      detail: "CLI ausente.",
      fix: "npm install -g @openai/codex",
    },
    {
      id: "vm-system",
      label: "Apple container · serviço",
      status: "fail",
      ok: false,
      detail: "Serviço parado.",
      fix: "container system start",
    },
  ],
}
const deferred = <T,>() => {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const apiWithDoctor = (doctor: (input: { refresh?: boolean }) => Promise<DoctorReport>): UiApi => {
  const api = createMockApi()
  const request: ApiRequest = async (route, input, path) =>
    route === "GET /doctor"
      ? ((await doctor(input as { refresh?: boolean })) as never)
      : api.request(route, input, path)
  return { ...api, request }
}

it("shows a VM MCP startup failure in pt-BR with a refresh action", () => {
  render(
    <DoctorChecks
      doctor={{
        ...report,
        checks: [
          {
            id: "vm-mcp:checkout",
            label: "Ferramentas do touri · Checkout",
            status: "fail",
            ok: false,
            detail: "As ferramentas do touri não carregaram nesta máquina. Tente novamente.",
            fix: null,
          },
        ],
      }}
      error={null}
      onRefresh={vi.fn()}
    />,
  )
  expect(screen.getByText("Ferramentas do touri · Checkout")).toBeVisible()
  expect(screen.getByText(/As ferramentas do touri não carregaram nesta máquina/)).toBeVisible()
  expect(screen.getByRole("button", { name: "Verificar novamente" })).toBeEnabled()
})

it("renders three distinct statuses, pt-BR explanations, safe commands and the privacy note", () => {
  render(<DoctorChecks doctor={report} error={null} onRefresh={vi.fn()} />)
  expect(screen.getByText("1 pronto · 1 aviso · 1 falha")).toBeVisible()
  expect(screen.getByText("Pronto")).toBeVisible()
  expect(screen.getByText("Atenção")).toBeVisible()
  expect(screen.getByText("Falha")).toBeVisible()
  expect(screen.getByText("OpenAI · DNS")).toBeVisible()
  expect(screen.getByText("container system start")).toBeVisible()
  expect(screen.getByText(/conversas e credenciais não são enviadas/)).toBeVisible()
  expect(screen.getAllByRole("list", { name: /^Verificações do ambiente/ })[0]).toHaveAttribute("aria-busy", "false")
})

it("copies exact commands on one click and never executes a repair", async () => {
  const writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
  render(<DoctorChecks doctor={report} error={null} onRefresh={vi.fn()} />)
  fireEvent.click(screen.getByRole("button", { name: "Copiar comando para Apple container · serviço" }))
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("container system start"))
  expect(await screen.findByText("Copiado")).toBeVisible()
})

it("announces the copied command for two seconds and restarts the timeout on another copy", async () => {
  vi.useFakeTimers()
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  })
  const view = render(<DoctorChecks doctor={report} error={null} onRefresh={vi.fn()} />)
  const button = screen.getByRole("button", { name: "Copiar comando para Apple container · serviço" })
  await act(async () => fireEvent.click(button))
  expect(button).toHaveTextContent("Copiado")
  expect(button.closest(".doctor-fix")?.querySelector('[aria-live="polite"]')).toHaveTextContent("Copiado")
  await act(async () => vi.advanceTimersByTimeAsync(1500))
  await act(async () => fireEvent.click(button))
  await act(async () => vi.advanceTimersByTimeAsync(1500))
  expect(button).toHaveTextContent("Copiado")
  await act(async () => vi.advanceTimersByTimeAsync(500))
  expect(button).toHaveTextContent("Copiar comando")
  await act(async () => fireEvent.click(button))
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it.each([0, 2])("uses plural statuses for %i checks of each kind", (count) => {
  const checks = report.checks.flatMap((check) =>
    Array.from({ length: count }, (_, index) => ({ ...check, id: `${check.id}-${index}` })),
  )
  render(<DoctorChecks doctor={{ ...report, checks }} error={null} onRefresh={vi.fn()} />)
  expect(screen.getByText(`${count} prontos · ${count} avisos · ${count} falhas`)).toBeVisible()
})

it("keeps the exact command selectable if clipboard permission is denied", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn(async () => {
        throw new Error("permission denied")
      }),
    },
  })
  render(<DoctorChecks doctor={report} error={null} onRefresh={vi.fn()} />)
  fireEvent.click(screen.getByRole("button", { name: "Copiar comando para Apple container · serviço" }))
  expect(await screen.findByText("Selecione o comando acima e copie manualmente.")).toBeVisible()
  expect(screen.getByText("container system start")).toBeVisible()
})

it("shows background progress, keeps cached results visible and disables concurrent refreshes", () => {
  const refresh = vi.fn()
  const view = render(<DoctorChecks doctor={{ ...report, running: true }} error={null} onRefresh={refresh} />)
  expect(screen.getByText("Verificando o ambiente…")).toBeVisible()
  expect(screen.getByText("OpenAI · DNS")).toBeVisible()
  expect(screen.getByRole("button", { name: "Verificar novamente" })).toBeDisabled()
  view.rerender(<DoctorChecks doctor={report} error={null} onRefresh={refresh} />)
  fireEvent.click(screen.getByRole("button", { name: "Verificar novamente" }))
  expect(refresh).toHaveBeenCalledTimes(1)
})

it("allows retry after a request fails and supports reports from older sidecars", () => {
  const refresh = vi.fn()
  const view = render(
    <DoctorChecks doctor={null} error="Não foi possível carregar o diagnóstico." onRefresh={refresh} />,
  )
  expect(screen.getByRole("alert")).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Verificar novamente" }))
  expect(refresh).toHaveBeenCalledOnce()
  view.rerender(
    <DoctorChecks
      doctor={{ checks: [{ id: "git", ok: true, detail: "Disponível.", fix: null }] }}
      error={null}
      onRefresh={refresh}
    />,
  )
  expect(screen.getByText("Pronto")).toBeVisible()
})

it("polls an in-flight report until ready, then uses refresh=true on demand", async () => {
  vi.useFakeTimers()
  const doctor = vi.fn(async () => report).mockResolvedValueOnce({ checks: [], running: true, checkedAt: null })
  const api = apiWithDoctor(doctor)
  const view = renderHook(() => useDoctorReport(api))
  await act(async () => undefined)
  expect(view.result.current.report?.running).toBe(true)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500)
  })
  expect(view.result.current.report).toEqual(report)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  expect(doctor).toHaveBeenCalledTimes(2)
  await act(async () => view.result.current.refresh())
  expect(doctor).toHaveBeenLastCalledWith({ refresh: true })
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it("ignores stale responses after refresh and cancels polling after unmount", async () => {
  vi.useFakeTimers()
  const initial = deferred<DoctorReport>()
  const doctor = vi.fn(async () => report).mockReturnValueOnce(initial.promise)
  const api = apiWithDoctor(doctor)
  const view = renderHook(() => useDoctorReport(api))
  await act(async () => view.result.current.refresh())
  await act(async () => initial.resolve({ checks: [], running: true }))
  expect(view.result.current.report).toEqual(report)
  expect(vi.getTimerCount()).toBe(0)
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it("failed diagnostic requests do not block the workspace and can be retried", async () => {
  const doctor = vi.fn(async () => report).mockRejectedValueOnce(new Error("offline"))
  const api = apiWithDoctor(doctor)
  const view = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(view.result.current.data.loading).toBe(false))
  expect(view.result.current.data.bots.length).toBeGreaterThan(0)
  expect(view.result.current.data.doctorError).toBe("Não foi possível carregar o diagnóstico. Tente novamente.")
  await act(async () => view.result.current.actions.refreshDoctor())
  expect(view.result.current.data.doctor).toEqual(report)
  expect(view.result.current.data.doctorError).toBeNull()
})

it("a slow diagnostic request does not delay startup conversations", async () => {
  const pending = deferred<DoctorReport>()
  const api = apiWithDoctor(async () => pending.promise)
  const view = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(view.result.current.data.loading).toBe(false))
  expect(view.result.current.data.bots.length).toBeGreaterThan(0)
  expect(view.result.current.data.doctor).toBeNull()
  view.unmount()
  pending.resolve(report)
})

it("does not poll while disabled and reloads the cached diagnostic after reconnect", async () => {
  const doctor = vi.fn(async () => report)
  const api = apiWithDoctor(doctor)
  let connection: ((connected: boolean) => void) | undefined
  api.subscribeConnection = (listener) => {
    connection = listener
    return () => {
      connection = undefined
    }
  }
  const view = renderHook(({ enabled }) => useDoctorReport(api, enabled), { initialProps: { enabled: false } })
  expect(doctor).not.toHaveBeenCalled()
  view.rerender({ enabled: true })
  await waitFor(() => expect(doctor).toHaveBeenCalledTimes(1))
  await act(async () => connection?.(true))
  expect(doctor).toHaveBeenCalledTimes(2)
  expect(doctor).toHaveBeenLastCalledWith({})
  view.unmount()
  expect(connection).toBeUndefined()
})

it("updates cached tool health after terminal run events without rerunning environment probes", async () => {
  const mock = createMockApi()
  const doctor = vi.fn(async (_input: { refresh?: boolean }) => report)
  const api = { ...apiWithDoctor(doctor), subscribe: mock.subscribe }
  const view = renderHook(() => useDoctorReport(api))
  await waitFor(() => expect(view.result.current.report).toEqual(report))
  const run: Run = {
    id: "health-run",
    botId: "bot-mark",
    threadId: "thread-mark",
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
    queuedAt: 1,
    startedAt: 2,
    finishedAt: null,
  }
  act(() => mock.emit({ type: "run.updated", run }))
  expect(doctor).toHaveBeenCalledTimes(1)
  const failed: DoctorReport = {
    ...report,
    checks: [
      { id: "local-mcp:bot-mark", label: "Tools", status: "fail", ok: false, detail: "Startup failed", fix: null },
    ],
  }
  doctor.mockResolvedValueOnce(failed)
  act(() => mock.emit({ type: "run.updated", run: { ...run, status: "failed", finishedAt: 3 } }))
  await waitFor(() => expect(view.result.current.report).toEqual(failed))
  act(() => mock.emit({ type: "run.updated", run: { ...run, status: "succeeded", finishedAt: 4 } }))
  await waitFor(() => expect(view.result.current.report).toEqual(report))
  expect(doctor.mock.calls).toEqual([[{}], [{}], [{}]])
  view.unmount()
  act(() => mock.emit({ type: "run.updated", run: { ...run, status: "failed", finishedAt: 5 } }))
  expect(doctor).toHaveBeenCalledTimes(3)
})
