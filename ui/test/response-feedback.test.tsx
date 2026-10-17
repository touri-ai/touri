import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { Run } from "@touri/contracts"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { ActivityMark } from "../src/components/ActivityMark"

let run: Run
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-10-17T12:00:00Z"))
  run = {
    id: "r",
    status: "starting",
    queuedAt: Date.now(),
    startedAt: Date.now(),
    providerStartedAt: Date.now(),
  } as Run
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms))

it("keeps a silent 35-second provider visible and checks connection without resending", async () => {
  const api = createMockApi()
  api.request = vi.fn().mockResolvedValue({ ok: true })
  const cancel = vi.fn().mockResolvedValue(undefined)
  const view = render(<ActivityMark state="thinking" run={run} api={api} onCancel={cancel} />)
  expect(screen.getByRole("status")).toHaveTextContent("Preparando a resposta…")
  advance(9_999)
  expect(screen.queryByText("Ainda aguardando a IA responder.")).toBeNull()
  advance(1)
  expect(screen.getByRole("status")).toHaveTextContent("Ainda aguardando a IA responder.")
  advance(20_000)
  expect(
    screen.getByText("A resposta está demorando. Você pode continuar esperando ou verificar a conexão."),
  ).toBeVisible()
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Verificar conexão" })))
  expect(screen.getByText("A conexão com o touri está disponível. A IA pode continuar demorando.")).toBeVisible()
  expect(api.request).toHaveBeenCalledExactlyOnceWith("GET /health", {})
  advance(5_000)
  view.rerender(
    <ActivityMark
      state="thinking"
      run={run}
      updatedAt={Date.now()}
      parts={[{ type: "reasoning", text: "Checking context", estimatedTokens: 120 }]}
    />,
  )
  expect(screen.getByRole("status")).toHaveTextContent("Preparando a resposta…")
  expect(screen.queryByText(/Checking|tokens|%/)).toBeNull()
  expect(screen.queryByText(/A resposta está demorando/)).toBeNull()
  advance(30_000)
  view.rerender(<ActivityMark state="thinking" run={run} api={api} onCancel={cancel} />)
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Parar", exact: true })))
  expect(cancel).toHaveBeenCalledExactlyOnceWith("r")
  view.rerender(<ActivityMark state="thinking" run={{ ...run, status: "canceled" }} />)
  expect(view.container).toBeEmptyDOMElement()
  expect(vi.getTimerCount()).toBe(0)
})

it("prioritizes approval over delay and resets after resolution and completion", () => {
  const view = render(<ActivityMark state="thinking" run={run} />)
  advance(30_000)
  view.rerender(
    <ActivityMark
      state="waiting-approval"
      run={run}
      parts={[{ type: "approval", approvalId: "a", request: "permission", detail: "Ler arquivo", decision: "pending" }]}
    />,
  )
  expect(screen.getByRole("link", { name: /Preciso da sua autorização/ })).toHaveAttribute("href", "#approval-a")
  expect(screen.queryByText(/A resposta está demorando/)).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
  advance(60_000)
  view.rerender(<ActivityMark state="thinking" run={run} />)
  expect(screen.getByRole("status")).toHaveTextContent("Preparando a resposta…")
  advance(10_000)
  expect(screen.getByRole("status")).toHaveTextContent("Ainda aguardando a IA responder.")
  view.rerender(<ActivityMark state="done" run={{ ...run, status: "succeeded" }} />)
  expect(view.container).toBeEmptyDOMElement()
  expect(vi.getTimerCount()).toBe(0)
})

it("distinguishes environment preparation, active tools and a silent provider", () => {
  const view = render(<ActivityMark state="thinking" run={{ ...run, providerStartedAt: null }} preparingEnvironment />)
  advance(10_000)
  expect(screen.getByRole("status")).toHaveTextContent("Preparando o ambiente…")
  view.rerender(
    <ActivityMark
      state="working-tool"
      run={run}
      parts={[
        {
          type: "tool_call",
          callId: "read",
          tool: "Read",
          summary: "Read",
          inputJson: '{"path":"/workspace/notas.md"}',
          outputJson: null,
          ok: null,
        },
      ]}
    />,
  )
  expect(screen.getByRole("status")).toHaveTextContent("A tarefa continua em execução.")
  view.rerender(<ActivityMark state="thinking" run={run} />)
  expect(screen.getByRole("status")).toHaveTextContent("Ainda aguardando a IA responder.")
})

it("reports connection failures without leaking details or changing the task", async () => {
  const api = createMockApi()
  api.request = vi.fn().mockRejectedValue(new Error("private transport detail"))
  render(<ActivityMark state="thinking" run={run} api={api} />)
  advance(30_000)
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Verificar conexão" })))
  expect(screen.getByText("Não foi possível conectar ao touri. Verifique sua conexão.")).toBeVisible()
  expect(screen.queryByText(/private transport/)).toBeNull()
  expect(api.request).toHaveBeenCalledExactlyOnceWith("GET /health", {})
})

it("localizes long waits and their actions in English", () => {
  const api = createMockApi()
  render(<ActivityMark state="thinking" locale="en" run={run} api={api} onCancel={async () => {}} />)
  advance(10_000)
  expect(screen.getByRole("status")).toHaveTextContent("Still waiting for the AI to respond.")
  advance(20_000)
  expect(screen.getByText("The reply is taking longer. You can keep waiting or check the connection.")).toBeVisible()
  expect(screen.getByRole("button", { name: "Check connection" })).toBeVisible()
  expect(screen.getByRole("button", { name: "Stop", exact: true })).toBeVisible()
})
