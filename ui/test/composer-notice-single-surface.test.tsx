import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Bot, MachineState, Message, Run } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
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

  expect(screen.queryByRole("button", { name: "Tentar novamente", exact: true })).toBeNull()
  expect(screen.getByRole("complementary")).toHaveTextContent(t("The computer needs attention"))
  expect(screen.getByRole("complementary")).toHaveTextContent(localizeNotice("network error: ECONNRESET"))
})

it("still reports a computer problem when no run failed", () => {
  renderNotice(undefined)

  expect(screen.getByRole("complementary")).toBeVisible()
})

const getRecoveryFixture = (diagnostic: string, errorClass: string) => {
  const api = createMockApi()
  const bot = api.getState().bots[0]
  const thread = api.getState().threads.find((item) => item.botId === bot?.id)
  if (!bot || !thread) throw new Error("Missing recovery fixture")

  const reply = { ...getFailedReply(), threadId: thread.id }
  const message: Message = {
    ...reply,
    parts: [{ type: "notice", level: "error", code: "run_failed", text: diagnostic }],
  }
  const run: Run = {
    id: "run",
    threadId: thread.id,
    botId: bot.id,
    provider: bot.provider,
    trigger: "user",
    requestMessageId: "request",
    replyMessageId: message.id,
    externalTurnId: null,
    status: "failed",
    errorClass,
    errorMessage: diagnostic,
    usage: null,
    routineRunId: null,
    queuedAt: 1,
    startedAt: 1,
    finishedAt: 2,
  }
  const original = api.request.bind(api)
  api.request = vi.fn((route, input, path) => {
    if (route === "GET /bots") return Promise.resolve({ bots: [{ ...bot, machine: "vm" }] })
    if (route === "GET /threads/:id/messages" && path?.id === thread.id)
      return Promise.resolve({ messages: [message], activeLeafId: message.id })
    if (route === "GET /threads/:id/runs" && path?.id === thread.id) return Promise.resolve({ runs: [run] })
    if (route === "GET /machines")
      return Promise.resolve({
        capability: { available: true, reason: null, provider: "apple-container" },
        machines: [{ ...getMachine(bot), error: diagnostic }],
      })
    if (route === "POST /runs/:id/retry") return Promise.resolve({ run: { ...run, id: "retry-run", status: "queued" } })

    return original(route, input, path)
  }) as typeof api.request

  return { api, bot }
}

it.each([
  ["network error: ECONNRESET", "cli_crash"],
  ["A máquina não ficou pronta em 90 s: Xvfb não iniciou ou o guest não respondeu", "timeout"],
])("offers one usable retry across the chat and computer notice: %s", async (diagnostic, errorClass) => {
  const { api } = getRecoveryFixture(diagnostic, errorClass)
  const user = userEvent.setup()

  render(<App kernel={{ services: { api } }} />)
  const retry = await screen.findByRole("button", { name: "Tentar novamente", exact: true })

  expect(screen.getAllByRole("button", { name: "Tentar novamente", exact: true })).toHaveLength(1)
  expect(screen.getByRole("complementary", { name: "Aviso do computador" })).toBeVisible()
  await user.click(retry)
  expect(api.request).toHaveBeenCalledWith("POST /runs/:id/retry", {}, { id: "run" })
})

it.each([
  ["machine_service_unavailable: Serviço do computador indisponível. [TOURI-E8001]", "machine_service_unavailable"],
  ["machine_service_start_failed: Não foi possível iniciar o serviço. [TOURI-E8002]", "machine_service_start_failed"],
])(
  "keeps the service-start recovery instead of retrying a disconnected service: %s",
  async (diagnostic, errorClass) => {
    const { api, bot } = getRecoveryFixture(diagnostic, errorClass)
    const user = userEvent.setup()

    render(<App kernel={{ services: { api } }} />)
    const actions = await screen.findAllByRole("button", { name: t("Start computer service"), exact: true })

    expect(screen.queryByRole("button", { name: "Tentar novamente", exact: true })).toBeNull()
    const action = actions[0]
    if (!action) throw new Error("Missing service recovery")
    await user.click(action)
    expect(api.request).toHaveBeenCalledWith("POST /machines/service/start", { botId: bot.id })
  },
)
