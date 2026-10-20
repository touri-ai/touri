import { cleanup, render, screen } from "@testing-library/react"
import type { Bot, MachineState, Message } from "@touri/contracts"
import { afterEach, expect, it } from "vitest"
import { createMockApi } from "../src/api/mock"
import { ComposerNotice } from "../src/components/ComposerNotice"
import { localizeNotice, t } from "../src/i18n"

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

const renderNotice = (latestReply: Message | undefined, status: MachineState["status"] = "error") => {
  const bot = getBot()
  render(
    <ComposerNotice
      bot={bot}
      latestReply={latestReply}
      machine={{ ...getMachine(bot), status }}
      active={false}
      api={api}
    />,
  )
}

it("does not add a computer card for a failed run while the computer is healthy", () => {
  renderNotice(getFailedReply(), "running")

  expect(screen.queryByRole("complementary")).toBeNull()
})

it("keeps the computer status without a second retry when the failed run's card already offers one", () => {
  const reply = getFailedReply()
  renderNotice({
    ...reply,
    parts: [{ type: "notice", level: "error", code: "machine_boot", text: "A máquina não ficou pronta" }],
  })

  expect(screen.queryAllByRole("button")).toHaveLength(0)
  expect(screen.getByRole("complementary")).toHaveTextContent(t("The computer needs attention"))
  expect(screen.getByRole("complementary")).toHaveTextContent(localizeNotice("network error: ECONNRESET"))
})

it("still reports a computer problem when no run failed", () => {
  renderNotice(undefined)

  expect(screen.getByRole("complementary")).toBeVisible()
})
