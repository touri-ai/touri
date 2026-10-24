import { cpuUsage } from "node:process"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { Message, Run } from "@touri/contracts"
import { Profiler } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { getStreamingHistory, longAnswer } from "./e2e/streaming-history-fixture"

afterEach(cleanup)

it.each([13, 250])("does not search successful history for recovery during deltas with %i turns", async (turns) => {
  const history = getStreamingHistory("thread", null, turns)
  const latest = history.messages.at(-1)
  const latestRun = history.runs.at(-1)
  if (!latest || !latestRun) throw new Error("Missing synthetic reply")
  // A local counter avoids allocating a spy record for every historical candidate read.
  let historicalReads = 0
  const observedRuns = history.runs.slice(0, -1).map((run) =>
    Object.defineProperty(Object.assign({}, run), "finishedAt", {
      get: () => {
        historicalReads += 1
        return run.finishedAt
      },
    }),
  )
  const activeRun = Object.assign({}, latestRun, { status: "running" as const, finishedAt: null })
  const runs = observedRuns.concat(activeRun)
  const plainRuns = history.runs.slice(0, -1).concat(activeRun)
  // Profiler uses an imperative callback; this bounded recorder stays local to the test.
  const renderDurations: number[] = []
  const onRetry = vi.fn(async () => {})
  const onSwitchBranch = vi.fn()
  const getMessages = (text: string): Message[] =>
    history.messages.slice(0, -1).concat(
      Object.assign({}, latest, {
        status: "streaming" as const,
        text,
        parts: latest.parts.filter((part) => part.type !== "text").concat({ type: "text", text }),
      }),
    )
  const getView = (text: string, currentRuns: Run[]) => (
    <Profiler id="streaming-list" onRender={(_id, _phase, duration) => renderDurations.push(duration)}>
      <VirtualMessageList
        messages={getMessages(text)}
        runs={currentRuns}
        onRetry={onRetry}
        onSwitchBranch={onSwitchBranch}
      />
    </Profiler>
  )
  const view = render(getView("Resposta", runs))
  const list = screen.getByTestId("virtual-message-list")
  Object.defineProperties(list, {
    clientHeight: { value: 900 },
    scrollHeight: { value: turns * 2 * 158 },
  })
  fireEvent.scroll(list, { target: { scrollTop: turns * 2 * 158 - 900 } })
  historicalReads = 0
  const texts = Array.from({ length: 30 }, (_, index) => longAnswer.slice(0, 80 + index * 20))

  texts.forEach((text) => {
    view.rerender(getView(text, runs))
  })
  const historicalRecoveryReads = historicalReads
  // Measure actual process CPU separately, with ordinary run properties and the identical deltas.
  view.rerender(getView("Resposta", plainRuns))
  const renderStart = renderDurations.length
  const cpuStart = cpuUsage()
  texts.forEach((text) => {
    view.rerender(getView(text, plainRuns))
  })
  const cpu = cpuUsage(cpuStart)
  const renders = renderDurations.slice(renderStart)
  const orderedRenders = renders.toSorted((left, right) => left - right)

  console.log(
    JSON.stringify({
      turns,
      deltas: texts.length,
      historicalRecoveryReads,
      cpuMs: (cpu.user + cpu.system) / 1000,
      renderCommits: renders.length,
      renderMs: renders.reduce((sum, duration) => sum + duration, 0),
      renderP99Ms: orderedRenders[Math.ceil(orderedRenders.length * 0.99) - 1] ?? 0,
    }),
  )
  await waitFor(() =>
    expect(view.container.querySelector(`[data-message-id="${latest.id}"]`)?.textContent).toContain("Etapa 1"),
  )
  expect(historicalRecoveryReads).toBe(0)
})

it.each(["failed", "streaming"] as const)("collapses recovered errors with stored status %s", (status) => {
  const history = getStreamingHistory("thread", null, 1)
  const reply = history.messages.at(-1)
  const run = history.runs[0]
  if (!reply || !run) throw new Error("Missing synthetic failure")
  const failed: Message = Object.assign({}, reply, {
    status,
    text: "",
    parts: [{ type: "notice", level: "error", code: "app_restart", text: "app_restart: Resposta interrompida." }],
  })
  const interrupted: Run = Object.assign({}, run, { status: "interrupted", errorClass: "app_restart" })
  const later: Message = Object.assign({}, reply, {
    id: "later-reply",
    runId: null,
    text: "Resposta salva depois da interrupção.",
    parts: [{ type: "text", text: "Resposta salva depois da interrupção." }],
    createdAt: reply.updatedAt + 1,
    updatedAt: reply.updatedAt + 1,
  })
  const onRetry = vi.fn(async () => {})
  const onSwitchBranch = vi.fn()
  const getView = (messages: Message[]) => (
    <VirtualMessageList messages={messages} runs={[interrupted]} onRetry={onRetry} onSwitchBranch={onSwitchBranch} />
  )
  const view = render(getView([failed]))
  expect(screen.getByRole("alert")).toBeVisible()

  view.rerender(getView([failed, later]))

  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: /houve uma resposta depois/ })).toHaveAttribute("aria-expanded", "false")
})
