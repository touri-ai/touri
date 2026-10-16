import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { Message, MessagePart, Run } from "@touri/contracts"
import { useEffect } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { ActivityMark } from "../src/components/ActivityMark"
import { type AvatarRuntime, AvatarRuntimeProvider, useMascotComposer } from "../src/components/AvatarRuntime"
import { BotAvatar } from "../src/components/BotAvatar"
import { VirtualMessageList } from "../src/components/ChatPanel"

const seed = createMockApi().getState()
const bot = seed.bots[0]
const thread = seed.threads.find((item) => item.botId === bot?.id)
if (!bot || !thread) throw new Error("Missing fixture bot")
const run: Run = {
  id: "mascot-run",
  threadId: thread.id,
  botId: bot.id,
  provider: "codex",
  trigger: "user",
  requestMessageId: null,
  replyMessageId: "mascot-reply",
  externalTurnId: null,
  status: "running",
  errorClass: null,
  errorMessage: null,
  usage: null,
  routineRunId: null,
  queuedAt: 100,
  startedAt: 110,
  finishedAt: null,
}
const reply = (parts: MessagePart[], patch: Partial<Message> = {}): Message => ({
  id: "mascot-reply",
  threadId: thread.id,
  parentId: null,
  role: "assistant",
  kind: "text",
  status: "streaming",
  runId: run.id,
  text: "",
  parts,
  sender: null,
  source: "local",
  createdAt: 110,
  updatedAt: 120,
  ...patch,
})
const tool: MessagePart = {
  type: "tool_call",
  callId: "call",
  tool: "read",
  summary: "",
  inputJson: "{}",
  outputJson: null,
  ok: null,
}
const approval: MessagePart = {
  type: "approval",
  approvalId: "approval",
  request: "permission",
  detail: "",
  decision: "pending",
}
const value = (messages: Message[], runs = [run]): AvatarRuntime => ({
  bots: [bot],
  threads: [thread],
  messages,
  runs,
  notifications: [],
  loading: false,
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const scene = (runtime: AvatarRuntime) => (
  <AvatarRuntimeProvider value={runtime}>
    <BotAvatar bot={bot} threadId={thread.id} />
    <VirtualMessageList
      messages={runtime.messages}
      runs={runtime.runs}
      onSwitchBranch={() => undefined}
      onRetry={async () => undefined}
    />
  </AvatarRuntimeProvider>
)

const FocusedAvatar = ({ threadId }: { threadId: string }) => {
  const composer = useMascotComposer()
  useEffect(() => {
    composer?.({ botId: bot.id, threadId, focused: true, typing: false })
    return () => composer?.({ botId: bot.id, threadId, focused: false, typing: false })
  }, [threadId, composer])
  return <BotAvatar bot={bot} threadId={threadId} className="focused-probe" />
}

describe("mascot runtime integration", () => {
  it("keeps mascot and message activity in sync through thinking, tools, approval, text and completion", () => {
    const view = render(scene(value([reply([])])))
    const avatar = () => view.container.querySelector(".tb-avatar")
    const mark = () => view.container.querySelector(".activity-mark")
    const shape = avatar()?.getAttribute("data-avatar-shape")
    for (const [state, parts] of [
      ["thinking", []],
      ["working-tool", [tool]],
      ["waiting-approval", [tool, approval]],
      ["working-tool", [tool, { ...approval, decision: "approved" }]],
      [
        "typing",
        [
          { ...tool, ok: true },
          { type: "text", text: "Feito" },
        ],
      ],
    ] as const) {
      view.rerender(scene(value([reply([...parts])])))
      expect(avatar()).toHaveAttribute("data-mascot-state", state)
      expect(mark()).toHaveAttribute("data-mascot-state", state)
      if (state === "waiting-approval") expect(screen.getByRole("link", { name: "Aguardando você" })).toBeVisible()
      expect(avatar()).toHaveAttribute("data-avatar-shape", shape)
    }
    view.rerender(scene(value([reply([tool, approval])], [{ ...run, status: "succeeded", finishedAt: 140 }])))
    expect(mark()).toBeNull()
    expect(avatar()).toHaveAttribute("data-mascot-state", "done")
  })
  it("isolates thread activity while the sidebar still reflects work anywhere on the bot", () => {
    const other = { ...thread, id: "other-thread" }
    const runtime = { ...value([]), threads: [thread, other], runs: [{ ...run, threadId: other.id }] }
    const view = render(
      <AvatarRuntimeProvider value={runtime}>
        <BotAvatar bot={bot} className="sidebar-probe" />
        <BotAvatar bot={bot} threadId={thread.id} className="thread-probe" />
      </AvatarRuntimeProvider>,
    )
    expect(view.container.querySelector(".sidebar-probe")).toHaveAttribute("data-mascot-state", "thinking")
    expect(view.container.querySelector(".thread-probe")).toHaveAttribute("data-mascot-state", "idle")
  })
  it("registers a new conversation before its focused composer reports activity and releases the old focus", () => {
    const other = { ...thread, id: "new-thread" }
    const scenes = (selected: string, runtime: AvatarRuntime) => (
      <AvatarRuntimeProvider value={runtime}>
        <FocusedAvatar threadId={selected} />
        <BotAvatar bot={bot} threadId={thread.id} className="old-probe" />
      </AvatarRuntimeProvider>
    )
    const view = render(scenes(thread.id, value([], [])))
    expect(view.container.querySelector(".focused-probe")).toHaveAttribute("data-mascot-state", "listening")
    view.rerender(scenes(other.id, { ...value([], []), threads: [thread, other] }))
    expect(view.container.querySelector(".focused-probe")).toHaveAttribute("data-mascot-state", "listening")
    expect(view.container.querySelector(".old-probe")).toHaveAttribute("data-mascot-state", "idle")
  })
  it("reschedules a new completion even when the mascot is already done, then releases the timer", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    vi.spyOn(document, "hasFocus").mockReturnValue(true)
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    )
    vi.stubGlobal("cancelAnimationFrame", vi.fn())
    const completed = (finishedAt: number) =>
      value([reply([], { status: "complete" })], [{ ...run, status: "succeeded", finishedAt }])
    const view = render(scene(value([reply([])])))
    view.rerender(scene(completed(200)))
    expect(view.container.querySelector(".tb-avatar")).toHaveAttribute("data-mascot-state", "done")
    act(() => vi.advanceTimersByTime(600))
    view.rerender(scene(completed(300)))
    act(() => vi.advanceTimersByTime(1800))
    expect(view.container.querySelector(".tb-avatar")).toHaveAttribute("data-mascot-state", "done")
    act(() => vi.advanceTimersByTime(600))
    expect(view.container.querySelector(".tb-avatar")).toHaveAttribute("data-mascot-state", "idle")
    expect(vi.getTimerCount()).toBe(0)
    view.rerender(scene(value([reply([])])))
    view.rerender(scene(completed(400)))
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
  it("treats fetched history as a baseline instead of celebrating old replies", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false)
    const view = render(scene({ ...value([], []), bots: [], threads: [], loading: true }))
    view.rerender(scene(value([reply([], { status: "complete" })], [{ ...run, status: "succeeded", finishedAt: 200 }])))
    expect(view.container.querySelector(".tb-avatar")).toHaveAttribute("data-mascot-state", "idle")
  })
  it("shares approval and sleep with the activity mark, while hiding never changes lifecycle state", () => {
    const runtime = {
      ...value([reply([tool])]),
      computerGrantRequest: { botId: bot.id, threadId: thread.id, botName: bot.name },
    }
    const view = render(scene(runtime))
    expect(view.container.querySelector(".tb-avatar")).toHaveAttribute("data-mascot-state", "waiting-approval")
    expect(view.container.querySelector(".activity-mark")).toHaveTextContent("Aguardando você")
    view.rerender(scene({ ...runtime, bots: [{ ...bot, paused: true }] }))
    expect(view.container.querySelector(".tb-avatar")).toHaveAttribute("data-mascot-state", "sleeping")
    expect(view.container.querySelector(".activity-mark")).toBeNull()
    view.rerender(scene(value([])))
    vi.spyOn(document, "hidden", "get").mockReturnValue(true)
    fireEvent(document, new Event("visibilitychange"))
    expect(view.container.querySelector(".tb-avatar")).toHaveAttribute("data-mascot-state", "thinking")
    view.rerender(scene(value([], [])))
    expect(view.container.querySelector(".tb-avatar")).toHaveAttribute("data-mascot-state", "idle")
    vi.spyOn(document, "hidden", "get").mockReturnValue(false)
    fireEvent(document, new Event("visibilitychange"))
    expect(view.container.querySelector(".tb-avatar")).toHaveAttribute("data-mascot-state", "idle")
  })
  it("actual UI runtime events drive composer, pending replies, streaming and cancellation", async () => {
    const api = createMockApi()
    const view = render(<App kernel={{ services: { api } }} />)
    const box = await screen.findByRole("textbox", { name: "Mensagem para mark" })
    const avatar = () => view.container.querySelector(".chat-bot-chip .tb-avatar")
    fireEvent.focus(box)
    expect(avatar()).toHaveAttribute("data-mascot-state", "listening")
    fireEvent.change(box, { target: { value: "Vamos trabalhar" } })
    // r7 step 67: drafting remains listening; typing is reserved for streamed bot output.
    expect(avatar()).toHaveAttribute("data-mascot-state", "listening")
    act(() => api.emit({ type: "run.updated", run }))
    expect(avatar()).toHaveAttribute("data-mascot-state", "thinking")
    expect(view.container.querySelector("[data-pending-run] .activity-mark")).toHaveAttribute(
      "data-mascot-state",
      "thinking",
    )
    act(() => {
      api.emit({ type: "message.created", message: reply([tool]) })
      api.emit({ type: "thread.updated", thread: { ...thread, activeLeafId: "mascot-reply" } })
    })
    await waitFor(() => expect(avatar()).toHaveAttribute("data-mascot-state", "working-tool"))
    expect(view.container.querySelector("[data-pending-run]")).toBeNull()
    act(() =>
      api.emit({
        type: "message.updated",
        message: reply([
          { ...tool, ok: true },
          { type: "text", text: "" },
        ]),
      }),
    )
    act(() =>
      api.emit({
        type: "message.delta",
        threadId: thread.id,
        messageId: "mascot-reply",
        partIndex: 1,
        delta: "O resultado",
      }),
    )
    expect(avatar()).toHaveAttribute("data-mascot-state", "typing")
    expect(screen.getByText("O resultado")).toBeInTheDocument()
    act(() => api.emit({ type: "run.updated", run: { ...run, status: "canceled", finishedAt: 150 } }))
    expect(view.container.querySelector(".activity-mark")).toBeNull()
    fireEvent.blur(box)
    expect(avatar()).toHaveAttribute("data-mascot-state", "idle")
  })
  it("freezes activity and avatar under reduced motion while keeping readable state changes", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList)
    const raf = vi.spyOn(window, "requestAnimationFrame")
    const view = render(scene(value([reply([tool])])))
    expect(view.container.querySelector(".tb-avatar")).toHaveAttribute("data-avatar-animated", "false")
    expect(view.container.querySelector(".activity-mark")).toHaveTextContent("Lendo")
    view.rerender(scene(value([reply([tool, approval])])))
    expect(screen.getByRole("link", { name: "Aguardando você" })).toBeVisible()
    expect(view.container.querySelector(".activity-mark")).toHaveAttribute("data-reduced-motion", "true")
    expect(raf).not.toHaveBeenCalled()
  })
  it("shows a small bot and readable state without a progress bar", () => {
    const raf = vi.spyOn(window, "requestAnimationFrame")
    const view = render(<ActivityMark state="thinking" bot={bot} />)
    expect(screen.getByRole("status")).toHaveTextContent("Pensando")
    expect(view.container.querySelector(".activity-mascot [data-bot-id]")).toHaveAttribute("data-bot-id", bot.id)
    expect(view.container.querySelector(".activity-mascot")).toHaveAttribute("aria-hidden", "true")
    expect(view.container.querySelectorAll(".activity-dots i")).toHaveLength(3)
    expect(view.container.querySelector("linearGradient")).toBeNull()
    expect(screen.queryByRole("progressbar")).toBeNull()
    expect(raf).not.toHaveBeenCalled()
    view.rerender(<ActivityMark state="waiting-approval" parts={[approval]} bot={bot} />)
    expect(view.container.querySelector(".activity-dots")).toBeNull()
    view.rerender(<ActivityMark state="done" bot={bot} />)
    expect(view.container.querySelector(".activity-mark")).toBeNull()
  })
  it("scrolls and focuses the pending approval from the status link without answering it", () => {
    const reveal = vi.fn()
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: reveal })
    const api = createMockApi()
    render(
      <AvatarRuntimeProvider value={value([reply([tool, approval])])}>
        <VirtualMessageList
          messages={[reply([tool, approval])]}
          api={api}
          runs={[run]}
          onSwitchBranch={() => undefined}
          onRetry={async () => undefined}
        />
      </AvatarRuntimeProvider>,
    )
    fireEvent.click(screen.getByRole("link", { name: "Aguardando você" }))
    const card = screen.getByRole("article", { name: "Aprovação de ferramenta" })
    expect(card).toHaveFocus()
    expect(reveal.mock.contexts).toContain(card)
    expect(reveal).toHaveBeenCalledWith({ block: "center", behavior: "instant" })
    expect(api.calls).toHaveLength(0)
  })
})
