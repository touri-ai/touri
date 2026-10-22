import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ApprovalPart, Message, MessagePart, Run, ToolCallPart } from "@touri/contracts"
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

it("keeps provider reasoning and token estimates out of the main status in both languages", () => {
  for (const parts of [
    [{ type: "reasoning", text: "Checking the context", estimatedTokens: 120 }],
    [{ type: "reasoning", text: "", estimatedTokens: 350 }],
  ] as MessagePart[][]) {
    expect(activityLabelFor("thinking", parts)).toBe("Preparando a resposta…")
    expect(activityLabelFor("thinking", parts, "en")).toBe("Preparing a reply…")
    expect(activityLabelFor("working-tool", [...parts, read])).toBe("Lendo README.md…")
  }
  const props = { onSwitchBranch: () => undefined, onRetry: async () => undefined }
  const live: Message = { ...message, parts: [{ type: "reasoning", text: "", estimatedTokens: 120 }] }
  const view = render(<VirtualMessageList {...props} messages={[live]} />)
  expect(screen.getByRole("status")).toHaveTextContent("Preparando a resposta…")
  expect(view.container.querySelectorAll(".turn-activity")).toHaveLength(1)
  expect(screen.queryByRole("button", { name: "Raciocínio" })).toBeNull()
  view.rerender(<VirtualMessageList {...props} messages={[{ ...live, status: "complete" }]} />)
  expect(view.container.querySelector(".activity-mark")).toBeNull()
})

it("uses the requested locale for the activity mark without exposing reasoning", () => {
  render(
    <ActivityMark
      state="thinking"
      locale="en"
      parts={[{ type: "reasoning", text: "The user is asking for an image." }]}
    />,
  )
  expect(screen.getByRole("status")).toHaveTextContent("Preparing a reply…")
  expect(screen.getByRole("status")).not.toHaveTextContent("The user")
})

it("uses a safe file name for tool activity without exposing tool names, commands or credentials", () => {
  expect(
    activityLabelFor("working-tool", [
      {
        ...read,
        inputJson: '{"file_path":"/project/processWalletPayoutJob.ts","token":"synthetic-private-value"}',
      },
    ]),
  ).toBe("Lendo processWalletPayoutJob.ts…")
  expect(
    activityLabelFor("working-tool", [
      {
        ...bash,
        summary: "internal_raw_tool --token=synthetic-private-value",
      },
    ]),
  ).toBe("Trabalhando…")
})

it("updates a single live line, opens full reasoning and collapses it when the turn ends", () => {
  const props = { onSwitchBranch: () => undefined, onRetry: async () => undefined }
  const live: Message = { ...message, parts: [{ type: "reasoning", text: "Conferi a fila. Verificando o lock" }] }
  const view = render(<VirtualMessageList {...props} messages={[live]} />)
  const preview = screen.getByRole("button", { name: "Preparando a resposta…" })
  expect(preview).toHaveClass("turn-activity-toggle")
  expect(preview).toHaveAttribute("aria-expanded", "false")
  expect(preview.getAttribute("aria-controls")).toBeTruthy()
  expect(screen.queryByText("Conferi a fila. Verificando o lock")).toBeNull()
  expect(screen.queryByRole("button", { name: "Raciocínio" })).toBeNull()
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
  expect(screen.getByRole("button", { name: "Preparando a resposta…" })).toBe(preview)
  const reasoning: MessagePart[] = [{ type: "reasoning", text: "Conferi a fila. Verificando o lock do payout…" }]
  view.rerender(<VirtualMessageList {...props} messages={[{ ...live, parts: [...reasoning, read] }]} />)
  expect(screen.getByRole("button", { name: "Lendo README.md…" })).toBe(preview)
  fireEvent.click(screen.getByRole("button", { name: "Lendo README.md…" }))
  expect(preview).toHaveAttribute("aria-expanded", "true")
  expect(screen.getByRole("heading", { name: "Raciocínio" })).toBeVisible()
  expect(screen.getByText("Conferi a fila. Verificando o lock do payout…")).toBeVisible()
  view.rerender(<VirtualMessageList {...props} messages={[{ ...live, status: "complete" }]} />)
  expect(view.container.querySelector(".activity-mark")).toBeNull()
  expect(screen.getByRole("button", { name: "Atividade" })).toHaveAttribute("aria-expanded", "false")
  expect(screen.queryByText("Conferi a fila. Verificando o lock")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Atividade" }))
  expect(screen.getByText("Conferi a fila. Verificando o lock")).toBeVisible()
})

it("keeps live reasoning readable with reduced motion", () => {
  document.documentElement.dataset.motion = "reduce"
  const view = render(<ActivityMark state="thinking" parts={[{ type: "reasoning", text: "Conferindo a fila…" }]} />)
  try {
    expect(screen.getByRole("status")).toHaveTextContent("Preparando a resposta…")
    expect(view.container.querySelector(".activity-mark")).toHaveAttribute("data-reduced-motion", "true")
    expect(view.container.querySelector(".tb-avatar")).toHaveAttribute("data-avatar-animated", "false")
  } finally {
    view.unmount()
    delete document.documentElement.dataset.motion
  }
})

it("describes the current tool, skipping completed and interrupted calls", () => {
  expect(activityLabelFor("thinking", [])).toBe("Preparando a resposta…")
  expect(activityLabelFor("typing", [])).toBe("Trabalhando…")
  expect(activityLabelFor("working-tool", [read])).toBe("Lendo README.md…")
  expect(activityLabelFor("working-tool", [read, bash])).toBe("Trabalhando…")
  expect(activityLabelFor("working-tool", [read, { ...bash, ok: true }])).toBe("Lendo README.md…")
  expect(activityLabelFor("working-tool", [{ ...bash, resolution: "interrupted" }])).toBe("Trabalhando…")
  expect(activityLabelFor("working-tool", [read, { ...approval, decision: "denied" }])).toBe("Trabalhando…")
  expect(activityLabelFor("waiting-approval", [read, approval])).toBe("Preciso da sua autorização.")
})

it.each([
  ["Read", "Lendo README.md…", "Reading README.md…"],
  ["browser_open", "Lendo…", "Reading…"],
  ["mcp__web__web_search", "Pesquisando…", "Searching…"],
  ["Grep", "Pesquisando…", "Searching…"],
  ["mcp__mail__send_message", "Enviando…", "Sending…"],
  ["sendEmail", "Enviando…", "Sending…"],
  ["Bash", "Trabalhando…", "Working…"],
  ["internal_unfamiliar_tool", "Trabalhando…", "Working…"],
])("%s uses a plain action in both languages", (tool, portuguese, english) => {
  expect(activityLabelFor("working-tool", [{ ...read, tool }])).toBe(portuguese)
  expect(activityLabelFor("working-tool", [{ ...read, tool }], "en")).toBe(english)
})

it("localizes preparation, user attention and the remaining avatar titles", () => {
  expect(activityLabelFor("thinking", [], "en")).toBe("Preparing a reply…")
  expect(activityLabelFor("typing", [], "en")).toBe("Working…")
  expect(activityLabelFor("waiting-approval", [], "en")).toBe("I need your permission.")
  expect(mascotLabelFor("idle", "en")).toBe("Ready")
  expect(mascotLabelFor("listening", "en")).toBe("Listening to you")
  expect(mascotLabelFor("error", "en")).toBe("Needs attention")
  expect(mascotLabelFor("sleeping", "en")).toBe("Paused")
  expect(mascotLabelFor("done", "en")).toBe("Completed")
  expect(mascotLabelFor("parked", "en")).toBe("Resting")
})

for (const [action, expected] of [
  ["Aprovar", "Lendo README.md…"],
  ["Negar", "Preparando a resposta…"],
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
    expect(screen.getByRole("link", { name: "Preciso da sua autorização." })).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: action }))
    await screen.findByText(expected)
    expect(screen.queryByRole("link", { name: "Preciso da sua autorização." })).toBeNull()
    expect(view.container.querySelectorAll(".tool-call-card")).toHaveLength(1)
    expect(view.container.querySelector(".turn-activity .tool-call-card")).toBeNull()
    expect(view.container.querySelector("[data-approval-id]")?.closest(".turn-activity")).toBeNull()
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
  expect(screen.getByRole("link", { name: "Preciso da sua autorização." })).toHaveAttribute(
    "href",
    "#approval-bash-approval",
  )
  view.rerender(<VirtualMessageList {...props} messages={[{ ...message, status: "complete" }]} />)
  expect(view.container.querySelector(".activity-mark")).toBeNull()
})

it("replaces preparation as soon as the first text arrives while the activity snapshot still says thinking", () => {
  const view = render(<ActivityMark state="thinking" parts={[]} />)
  expect(screen.getByRole("status")).toHaveTextContent("Preparando a resposta…")

  view.rerender(<ActivityMark state="thinking" parts={[{ type: "text", text: "Olá!" }]} />)

  expect(screen.queryByText("Preparando a resposta…")).toBeNull()
  expect(screen.getByRole("status")).toHaveTextContent("Trabalhando…")
})

it("keeps the slow-response status when a partial reply stops arriving", () => {
  const startedAt = Date.now() - 31_000
  const run: Run = {
    id: "slow-run",
    threadId: "thread",
    botId: "bot",
    provider: "codex",
    trigger: "user",
    requestMessageId: "request",
    replyMessageId: "reply",
    externalTurnId: null,
    status: "running",
    errorClass: null,
    errorMessage: null,
    usage: null,
    routineRunId: null,
    queuedAt: startedAt,
    startedAt,
    providerStartedAt: startedAt,
    finishedAt: null,
  }

  render(<ActivityMark state="thinking" run={run} parts={[{ type: "text", text: "Olá!" }]} />)

  expect(screen.getByRole("status")).toHaveTextContent("A resposta está demorando.")
})
