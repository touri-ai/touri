import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ApprovalPart, Message, MessagePart, ToolCallPart } from "@touri/contracts"
import { afterEach, expect, it } from "vitest"
import { createMockApi } from "../src/api/mock"
import { ActivityMark } from "../src/components/ActivityMark"
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

it("updates hidden Claude thinking progress without an empty reasoning disclosure", () => {
  const props = { onSwitchBranch: () => undefined, onRetry: async () => undefined }
  const live: Message = { ...message, parts: [{ type: "reasoning", text: "", estimatedTokens: 120 }] }
  const view = render(<VirtualMessageList {...props} messages={[live]} />)
  const status = screen.getByRole("status")
  expect(status).toHaveTextContent("Pensando… (~120 tokens)")
  expect(screen.queryByRole("button", { name: "Raciocínio" })).toBeNull()
  expect(status.querySelector("button")).toBeNull()
  const parts: MessagePart[] = [{ type: "reasoning", text: "", estimatedTokens: 350 }]
  view.rerender(<VirtualMessageList {...props} messages={[{ ...live, parts }]} />)
  expect(screen.getByRole("status")).toBe(status)
  expect(status).toHaveTextContent("Pensando… (~350 tokens)")
  expect(activityLabelFor("thinking", parts, "en")).toBe("Thinking… (~350 tokens)")
  expect(activityLabelFor("thinking", [{ type: "reasoning", text: "", estimatedTokens: 0 }])).toBe("Pensando…")
  expect(activityLabelFor("working-tool", [...parts, read])).toBe("Lendo README.md")
  expect(activityLabelFor("typing", [...parts, { type: "text", text: "Pronto." }])).toBe("Trabalhando")
  view.rerender(<VirtualMessageList {...props} messages={[{ ...live, parts, status: "complete" }]} />)
  expect(view.container.querySelector(".activity-mark")).toBeNull()
  expect(screen.queryByRole("button", { name: "Raciocínio" })).toBeNull()
})

it("shows the latest reasoning sentence as deltas arrive, ahead of the generic activity", () => {
  const parts: MessagePart[] = [{ type: "reasoning", text: "Conferi a fila. Verificando o lock do payout" }]
  expect(activityLabelFor("thinking", parts)).toBe("Pensando: Verificando o lock do payout")
  expect(
    activityLabelFor("thinking", [{ type: "reasoning", text: "Conferi a fila.\nVerificando o lock do payout…" }]),
  ).toBe("Pensando: Verificando o lock do payout…")
  expect(
    activityLabelFor("thinking", [{ type: "reasoning", text: "Conferi a fila. Verificando\no lock do payout…" }]),
  ).toBe("Pensando: Verificando o lock do payout…")
  expect(activityLabelFor("working-tool", [read, ...parts], "en")).toBe("Thinking: Verificando o lock do payout")
  expect(activityLabelFor("working-tool", [...parts, read])).toBe("Lendo README.md")
  expect(activityLabelFor("thinking", [...parts, { ...read, ok: true }])).toBe("Pensando")
  expect(activityLabelFor("thinking", [{ type: "reasoning", text: " \n " }])).toBe("Pensando")
})

it("keeps previews short and clears reasoning when streaming gives way to text or a terminal state", () => {
  const parts: MessagePart[] = [{ type: "reasoning", text: `Conferindo ${"arquivo ".repeat(40)}` }]
  const label = activityLabelFor("thinking", parts)
  expect(label).toHaveLength(160)
  expect(label.endsWith("…")).toBe(true)
  expect(label).not.toContain("\n")
  expect(activityLabelFor("typing", parts)).toBe("Trabalhando")
  expect(activityLabelFor("done", parts)).toBe("Concluído")
  expect(activityLabelFor("idle", parts)).toBe("Pronto")
  expect(activityLabelFor("error", parts)).toBe("Precisa de atenção")
  expect(activityLabelFor("waiting-approval", parts)).toBe("Aguardando você")
})

it("uses a safe file name for tool activity without exposing tool names, commands or credentials", () => {
  expect(
    activityLabelFor("working-tool", [
      {
        ...read,
        inputJson: '{"file_path":"/project/processWalletPayoutJob.ts","token":"synthetic-private-value"}',
      },
    ]),
  ).toBe("Lendo processWalletPayoutJob.ts")
  expect(
    activityLabelFor("working-tool", [
      {
        ...bash,
        summary: "internal_raw_tool --token=synthetic-private-value",
      },
    ]),
  ).toBe("Trabalhando")
})

it("updates a single live line, opens full reasoning and collapses it when the turn ends", () => {
  const props = { onSwitchBranch: () => undefined, onRetry: async () => undefined }
  const live: Message = { ...message, parts: [{ type: "reasoning", text: "Conferi a fila. Verificando o lock" }] }
  const view = render(<VirtualMessageList {...props} messages={[live]} />)
  const disclosure = screen.getByRole("button", { name: "Raciocínio" })
  expect(disclosure).toHaveAttribute("aria-expanded", "false")
  const preview = screen.getByRole("button", { name: "Pensando: Verificando o lock" })
  expect(preview).toHaveAttribute("aria-controls", disclosure.getAttribute("aria-controls"))
  view.rerender(
    <VirtualMessageList
      {...props}
      messages={[
        {
          ...live,
          parts: [{ type: "reasoning", text: "Conferi a fila. Verificando o lock do payout…" }],
        },
      ]}
    />,
  )
  expect(screen.getByRole("button", { name: "Pensando: Verificando o lock do payout…" })).toBe(preview)
  const reasoning: MessagePart[] = [{ type: "reasoning", text: "Conferi a fila. Verificando o lock do payout…" }]
  view.rerender(<VirtualMessageList {...props} messages={[{ ...live, parts: [...reasoning, read] }]} />)
  expect(screen.getByRole("button", { name: "Lendo README.md" })).toBe(preview)
  fireEvent.click(screen.getByRole("button", { name: "Lendo README.md" }))
  expect(disclosure).toHaveAttribute("aria-expanded", "true")
  expect(screen.getByText("Conferi a fila. Verificando o lock do payout…")).toBeVisible()
  view.rerender(<VirtualMessageList {...props} messages={[{ ...live, status: "complete" }]} />)
  expect(view.container.querySelector(".activity-mark")).toBeNull()
  expect(screen.getByRole("button", { name: "Raciocínio" })).toHaveAttribute("aria-expanded", "false")
  fireEvent.click(screen.getByRole("button", { name: "Raciocínio" }))
  expect(screen.getByText("Conferi a fila. Verificando o lock")).toBeVisible()
})

it("keeps live reasoning readable with reduced motion", () => {
  document.documentElement.dataset.motion = "reduce"
  const view = render(<ActivityMark state="thinking" parts={[{ type: "reasoning", text: "Conferindo a fila…" }]} />)
  try {
    expect(screen.getByRole("status")).toHaveTextContent("Pensando: Conferindo a fila…")
    expect(view.container.querySelector(".activity-mark")).toHaveAttribute("data-reduced-motion", "true")
    expect(view.container.querySelector(".tb-avatar")).toHaveAttribute("data-avatar-animated", "false")
  } finally {
    view.unmount()
    delete document.documentElement.dataset.motion
  }
})

it("describes the current tool, skipping completed and interrupted calls", () => {
  expect(activityLabelFor("thinking", [])).toBe("Pensando")
  expect(activityLabelFor("typing", [])).toBe("Trabalhando")
  expect(activityLabelFor("working-tool", [read])).toBe("Lendo README.md")
  expect(activityLabelFor("working-tool", [read, bash])).toBe("Trabalhando")
  expect(activityLabelFor("working-tool", [read, { ...bash, ok: true }])).toBe("Lendo README.md")
  expect(activityLabelFor("working-tool", [{ ...bash, resolution: "interrupted" }])).toBe("Trabalhando")
  expect(activityLabelFor("working-tool", [read, { ...approval, decision: "denied" }])).toBe("Trabalhando")
  expect(activityLabelFor("waiting-approval", [read, approval])).toBe("Aguardando você")
})

it.each([
  ["Read", "Lendo README.md", "Reading README.md"],
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
  ["Aprovar", "Lendo README.md"],
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
