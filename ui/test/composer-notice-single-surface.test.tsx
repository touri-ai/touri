import { cleanup, render, screen } from "@testing-library/react"
import type { Bot, MachineState, Message } from "@touri/contracts"
import { afterEach, expect, it } from "vitest"
import { createMockApi } from "../src/api/mock"
import { ComposerNotice } from "../src/components/ComposerNotice"

afterEach(cleanup)

const api = createMockApi()

const getBot = (): Bot => {
  const bot = api.getState().bots[0]
  if (!bot) throw new Error("Missing bot fixture")

  return { ...bot, machine: "vm" }
}

const getMachine = (bot: Bot): MachineState => ({
  botId: bot.id,
  status: "error",
  progress: null,
  error: "network error: ECONNRESET",
  memoryMb: 2048,
  createdMs: null,
  startMs: null,
})

const getFailedReply = (): Message => ({
  id: "failure",
  threadId: "thread",
  parentId: null,
  role: "assistant",
  kind: "text",
  status: "failed",
  runId: "run",
  text: "",
  parts: [{ type: "notice", level: "error", code: "run_failed", text: "network error: ECONNRESET" }],
  sender: null,
  source: "local",
  createdAt: 1,
  updatedAt: 1,
})

const renderNotice = (latestReply: Message | undefined) => {
  const bot = getBot()
  render(
    <ComposerNotice
      bot={bot}
      latestReply={latestReply}
      machine={getMachine(bot)}
      active={false}
      api={api}
      onRetry={async () => undefined}
    />,
  )
}

it("does not repeat a failed run above the composer when the conversation already shows it", () => {
  renderNotice(getFailedReply())

  expect(screen.queryByRole("complementary")).toBeNull()
  expect(screen.queryByRole("button", { name: "Tentar novamente" })).toBeNull()
})

it("still reports a computer problem when no run failed", () => {
  renderNotice(undefined)

  expect(screen.getByRole("complementary")).toBeVisible()
})
