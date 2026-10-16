import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ApprovalPart, Message, ToolCallPart } from "@touri/contracts"
import { afterEach, expect, it } from "vitest"
import { createMockApi } from "../src/api/mock"
import { AvatarRuntimeProvider } from "../src/components/AvatarRuntime"
import { activityLabelFor } from "../src/components/activityStatus"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { mascotLabelFor } from "../src/components/mascotState"

const read: ToolCallPart = {
  type: "tool_call",
  callId: "read",
  tool: "Read",
  summary: "Claude tool Read",
  inputJson: '{"file_path":"/project/README.md"}',
  outputJson: null,
  ok: null,
}
const bash: ToolCallPart = { ...read, callId: "bash", tool: "Bash", inputJson: '{"command":"pwd"}' }
const approval: ApprovalPart = {
  type: "approval",
  approvalId: "read-approval",
  request: "permission",
  detail: `Read: ${read.inputJson}`,
  scope: { source: "claude", tool: "Read" },
  decision: "pending",
}
const message: Message = {
  id: "reply",
  threadId: "thread",
  parentId: null,
  role: "assistant",
  kind: "tool",
  status: "streaming",
  runId: null,
  text: "",
  parts: [read, approval],
  sender: null,
  source: "local",
  createdAt: 1,
  updatedAt: 1,
}

afterEach(cleanup)

it("describes the current tool, skipping completed and interrupted calls", () => {
  expect(activityLabelFor("thinking", [])).toBe("Pensando")
  expect(activityLabelFor("typing", [])).toBe("Trabalhando")
  expect(activityLabelFor("working-tool", [read])).toBe("Lendo")
  expect(activityLabelFor("working-tool", [read, bash])).toBe("Trabalhando")
  expect(activityLabelFor("working-tool", [read, { ...bash, ok: true }])).toBe("Lendo")
  expect(activityLabelFor("working-tool", [{ ...bash, resolution: "interrupted" }])).toBe("Trabalhando")
  expect(activityLabelFor("working-tool", [read, { ...approval, decision: "denied" }])).toBe("Trabalhando")
  expect(activityLabelFor("waiting-approval", [read, approval])).toBe("Aguardando você")
})

it.each([
  ["Read", "Lendo", "Reading"],
  ["browser_open", "Lendo", "Reading"],
  ["mcp__web__web_search", "Pesquisando", "Searching"],
  ["Grep", "Pesquisando", "Searching"],
  ["mcp__mail__send_message", "Enviando", "Sending"],
  ["sendEmail", "Enviando", "Sending"],
  ["Bash", "Trabalhando", "Working"],
  ["internal_unfamiliar_tool", "Trabalhando", "Working"],
])("%s uses a plain action in both languages", (tool, portuguese, english) => {
  expect(activityLabelFor("working-tool", [{ ...read, tool }])).toBe(portuguese)
  expect(activityLabelFor("working-tool", [{ ...read, tool }], "en")).toBe(english)
})

it("localizes preparation, user attention and the remaining avatar titles", () => {
  expect(activityLabelFor("thinking", [], "en")).toBe("Thinking")
  expect(activityLabelFor("typing", [], "en")).toBe("Working")
  expect(activityLabelFor("waiting-approval", [], "en")).toBe("Waiting for you")
  expect(mascotLabelFor("idle", "en")).toBe("Ready")
  expect(mascotLabelFor("listening", "en")).toBe("Listening to you")
  expect(mascotLabelFor("error", "en")).toBe("Needs attention")
  expect(mascotLabelFor("sleeping", "en")).toBe("Paused")
  expect(mascotLabelFor("done", "en")).toBe("Completed")
  expect(mascotLabelFor("parked", "en")).toBe("Resting")
})

for (const [action, expected] of [
  ["Aprovar", "Lendo"],
  ["Negar", "Pensando"],
] as const) {
  it(`updates the status immediately after ${action}, before server events arrive`, async () => {
    const api = createMockApi()
    const bot = api.getState().bots[0]
    const thread = api.getState().threads[0]
    if (!bot || !thread) throw new Error("Missing bot or thread")
    const view = render(
      <AvatarRuntimeProvider
        value={{
          bots: [bot],
          threads: [{ ...thread, id: "thread", botId: bot.id }],
          messages: [message],
          runs: [],
          notifications: [],
          loading: false,
        }}
      >
        <VirtualMessageList
          api={api}
          messages={[message]}
          onSwitchBranch={() => undefined}
          onRetry={async () => undefined}
        />
      </AvatarRuntimeProvider>,
    )
    expect(screen.getByRole("link", { name: "Aguardando você" })).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: action }))
    await screen.findByText(expected)
    expect(screen.queryByRole("link", { name: "Aguardando você" })).toBeNull()
    expect(view.container.querySelectorAll(".tool-call-card")).toHaveLength(1)
    expect(view.container.querySelector(".activity-mark .tb-avatar")).toHaveAttribute("data-bot-id", bot.id)
  })
}

it("keeps the next pending request actionable and removes activity when the reply finishes", async () => {
  const api = createMockApi()
  const second: ApprovalPart = {
    ...approval,
    approvalId: "bash-approval",
    detail: `Bash: ${bash.inputJson}`,
    scope: { source: "claude", tool: "Bash" },
  }
  const props = {
    api,
    messages: [{ ...message, parts: [read, approval, bash, second] }],
    onSwitchBranch: () => undefined,
    onRetry: async () => undefined,
  }
  const view = render(<VirtualMessageList {...props} />)
  const approve = screen.getAllByRole("button", { name: "Aprovar" })[0]
  if (!approve) throw new Error("Missing approval button")
  fireEvent.click(approve)
  await screen.findByText("Aprovado por você")
  expect(screen.getByRole("link", { name: "Aguardando você" })).toHaveAttribute("href", "#approval-bash-approval")
  view.rerender(<VirtualMessageList {...props} messages={[{ ...message, status: "complete" }]} />)
  expect(view.container.querySelector(".activity-mark")).toBeNull()
})
