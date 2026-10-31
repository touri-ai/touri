import { cleanup, render } from "@testing-library/react"
import type { Message } from "@touri/contracts"
import { afterEach, expect, it } from "vitest"
import { createMockApi } from "../src/api/mock"
import { ActivityMark } from "../src/components/ActivityMark"
import { AvatarRuntimeProvider } from "../src/components/AvatarRuntime"
import { VirtualMessageList } from "../src/components/ChatPanel"

afterEach(cleanup)

const getApiFixture = () => {
  const api = createMockApi()
  const bot = api.getState().bots[0]
  const thread = api.getState().threads[0]
  if (!bot || !thread) throw new Error("Missing bot or thread")

  return { api, bot, thread: { ...thread, id: "thread", botId: bot.id } }
}

const getMessage = (id: string, overrides: Partial<Message> = {}): Message => ({
  id,
  threadId: "thread",
  parentId: null,
  role: "assistant",
  kind: "text",
  status: "complete",
  runId: null,
  text: "Pronto.",
  parts: [{ type: "text", text: "Pronto." }],
  sender: null,
  source: "local",
  createdAt: 1_000,
  updatedAt: 1_000,
  ...overrides,
})

const getLive = (id: string, overrides: Partial<Message> = {}): Message =>
  getMessage(id, {
    status: "streaming",
    text: "",
    parts: [{ type: "reasoning", text: "", estimatedTokens: 10 }],
    createdAt: 2_000,
    ...overrides,
  })

const renderRows = (messages: Message[], sender: boolean) => {
  const { api, bot, thread } = getApiFixture()
  const rows = messages.map((message) => (sender ? { ...message, sender: { id: bot.id, name: bot.name } } : message))

  return render(
    <AvatarRuntimeProvider
      value={{ bots: [bot], threads: [thread], messages: rows, runs: [], notifications: [], loading: false }}
    >
      <VirtualMessageList
        api={api}
        messages={rows}
        flatHistory={sender}
        onSwitchBranch={() => undefined}
        onRetry={async () => undefined}
      />
    </AvatarRuntimeProvider>,
  )
}

const getLiveRow = (container: HTMLElement) => {
  const row = container.querySelector<HTMLElement>('[data-message-id="live"]')
  if (!row) throw new Error("Missing live row")

  return row
}

for (const [conversation, sender] of [
  ["dm", false],
  ["channel", true],
] as const) {
  it(`draws one avatar in an ungrouped active bot row in a ${conversation}`, () => {
    const view = renderRows([getLive("live")], sender)
    const row = getLiveRow(view.container)

    expect(row.querySelectorAll(".tb-avatar")).toHaveLength(1)
    expect(row.querySelector(".message-avatar .tb-avatar")).not.toBeNull()
    expect(row.querySelector(".activity-mark .tb-avatar")).toBeNull()
    expect(row.querySelector(".activity-mark .activity-dots[data-leading]")).not.toBeNull()
    expect(row.querySelector(".activity-mark .turn-activity-chevron")).toBeNull()
  })

  it(`draws one avatar in a grouped active bot row in a ${conversation}`, () => {
    const view = renderRows([getMessage("before"), getLive("live", { createdAt: 1_500, parentId: "before" })], sender)
    const row = getLiveRow(view.container)

    expect(row).toHaveAttribute("data-message-grouped", "true")
    expect(row.querySelectorAll(".tb-avatar")).toHaveLength(1)
  })
}

it("keeps its own avatar when used standalone", () => {
  const view = render(<ActivityMark state="thinking" />)

  expect(view.container.querySelectorAll(".activity-mark .tb-avatar")).toHaveLength(1)
})

it("omits its avatar when the row already has one", () => {
  const view = render(<ActivityMark state="thinking" showAvatar={false} />)

  expect(view.container.querySelector(".tb-avatar")).toBeNull()
  expect(view.container.querySelectorAll(".activity-dots")).toHaveLength(1)
})
