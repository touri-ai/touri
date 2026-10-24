import { cleanup, render } from "@testing-library/react"
import type { Message, Run } from "@touri/contracts"
import { afterEach, expect, it } from "vitest"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { getBrowserTurnMessage, getBrowserTurnRun } from "./browser-turn-fixture"

const languageCleanups = new Set<() => void>()

afterEach(() => {
  cleanup()
  languageCleanups.forEach((restore) => {
    restore()
  })
  languageCleanups.clear()
})

it.each<{
  messageStatus: Message["status"]
  runStatus: Run["status"] | undefined
}>([
  { messageStatus: "canceled", runStatus: undefined },
  { messageStatus: "canceled", runStatus: "canceled" },
  { messageStatus: "canceled", runStatus: "succeeded" },
  { messageStatus: "complete", runStatus: "canceled" },
  { messageStatus: "streaming", runStatus: "canceled" },
])("shows one canceled status with message=$messageStatus and run=$runStatus", ({ messageStatus, runStatus }) => {
  const message = getBrowserTurnMessage({ status: messageStatus })
  const runs = runStatus ? [getBrowserTurnRun(runStatus)] : []

  const { container } = renderBrowserTurn(message, runs)
  const meta = getMessageMeta(container)

  expect(meta.querySelectorAll('[role="status"]')).toHaveLength(1)
  expect(meta).toHaveTextContent("Cancelado por você")
  expect(meta).not.toHaveTextContent(/concluído|falhou|em andamento/)
  expect(container.querySelectorAll(".chat-terminal-status")).toHaveLength(1)
  expect(container).toHaveTextContent(message.text)
})

it.each<{
  messageStatus: Message["status"]
  runStatus: Run["status"] | undefined
}>([
  { messageStatus: "failed", runStatus: undefined },
  { messageStatus: "failed", runStatus: "failed" },
  { messageStatus: "failed", runStatus: "succeeded" },
  { messageStatus: "complete", runStatus: "failed" },
  { messageStatus: "streaming", runStatus: "failed" },
])("shows failure for a $messageStatus browser message and $runStatus run", ({ messageStatus, runStatus }) => {
  const message = getBrowserTurnMessage({ status: messageStatus })
  const runs = runStatus ? [getBrowserTurnRun(runStatus)] : []

  const { container } = renderBrowserTurn(message, runs)
  const meta = getMessageMeta(container)

  expect(meta.querySelectorAll('[role="status"]')).toHaveLength(1)
  expect(meta).toHaveTextContent("falhou")
  expect(meta).not.toHaveTextContent(/concluído|Cancelado por você|em andamento/)
})

it.each<{
  messageStatus: Message["status"]
  runStatus: Run["status"]
  label: string
}>([
  { messageStatus: "streaming", runStatus: "running", label: "em andamento" },
  { messageStatus: "complete", runStatus: "succeeded", label: "concluído" },
])("preserves $label for a $runStatus browser turn", ({ messageStatus, runStatus, label }) => {
  const message = getBrowserTurnMessage({ status: messageStatus })
  const run = getBrowserTurnRun(runStatus)

  const { container } = renderBrowserTurn(message, [run])
  const meta = getMessageMeta(container)

  expect(meta.querySelectorAll('[role="status"]')).toHaveLength(1)
  expect(meta.querySelector(".browser-run-state")).toHaveTextContent(label)
})

it("preserves the incomplete label when a browser handoff expires", () => {
  const reply = getBrowserTurnMessage({ status: "failed" })
  const message = getBrowserTurnMessage({
    status: "failed",
    parts: reply.parts.concat({
      type: "notice",
      code: "run_failed",
      level: "error",
      text: "No one took over in time. Ask again when you can.",
    }),
  })

  const { container } = renderBrowserTurn(message, [getBrowserTurnRun("failed")])
  const meta = getMessageMeta(container)

  expect(meta.querySelector(".browser-run-state")).toHaveTextContent("não concluído")
  expect(meta).not.toHaveTextContent("falhou")
  expect(container).toHaveTextContent("Ninguém assumiu a tempo. Peça de novo quando puder.")
})

it("keeps the cancellation chip for a reply without browser tools", () => {
  const reply = getBrowserTurnMessage()
  const message = getBrowserTurnMessage({ parts: reply.parts.filter((part) => part.type !== "tool_call") })

  const { container } = renderBrowserTurn(message, [getBrowserTurnRun()])
  const meta = getMessageMeta(container)

  expect(meta.querySelectorAll('[role="status"]')).toHaveLength(1)
  expect(meta).toHaveTextContent("Cancelado por você")
  expect(meta.querySelector(".browser-run-state")).toBeNull()
  expect(container).toHaveTextContent(message.text)
})

it.each<{ status: Message["status"]; label: string }>([
  { status: "canceled", label: "Canceled by you" },
  { status: "failed", label: "Failed" },
  { status: "complete", label: "finished" },
])("shows the English $label status in an English conversation", ({ status, label }) => {
  languageCleanups.add(setDocumentLanguage("en"))
  const message = getBrowserTurnMessage({ status })

  const { container } = renderBrowserTurn(message, [])
  const meta = getMessageMeta(container)

  expect(meta.querySelectorAll('[role="status"]')).toHaveLength(1)
  expect(meta.querySelector('[role="status"]')).toHaveTextContent(label)
  expect(meta).not.toHaveTextContent(/Cancelado por você|falhou|concluído/)
})

const renderBrowserTurn = (message: Message, runs: Run[]) =>
  render(
    <VirtualMessageList
      messages={[message]}
      runs={runs}
      onSwitchBranch={() => undefined}
      onRetry={async () => undefined}
    />,
  )

const setDocumentLanguage = (locale: string): (() => void) => {
  const previous = document.documentElement.lang
  document.documentElement.lang = locale

  return () => {
    document.documentElement.lang = previous
  }
}

const getMessageMeta = (container: HTMLElement): HTMLElement => {
  const meta = container.querySelector<HTMLElement>(".message-meta")
  if (!meta) throw new Error("Missing browser message metadata")

  return meta
}
