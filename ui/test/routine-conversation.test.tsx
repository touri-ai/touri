import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { Message, Routine, RoutineRun, Run } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { ChatPanel, VirtualMessageList } from "../src/components/ChatPanel"
import { t } from "../src/i18n"
import { getRoutineReplyRun } from "../src/routineConversation"

afterEach(cleanup)

const getFixture = () => {
  const api = createMockApi()
  const state = api.getState()
  const bot = state.bots[0]
  const thread = state.threads[0]
  if (!bot || !thread) throw new Error("Missing conversation fixture")

  const prompt: Message = {
    id: "routine-request",
    threadId: thread.id,
    parentId: null,
    role: "user",
    kind: "text",
    status: "complete",
    runId: null,
    text: "Leia as mensagens novas.\n\nIgnore promoções e mantenha a caixa intacta.",
    parts: [],
    sender: null,
    source: "local",
    createdAt: 1000,
    updatedAt: 1000,
  }
  const reply: Message = {
    ...prompt,
    id: "routine-reply",
    parentId: prompt.id,
    role: "assistant",
    runId: "routine-run",
    text: "NO_NOTIFICATION",
    parts: [{ type: "text", text: "NO_NOTIFICATION" }],
    createdAt: 2000,
    updatedAt: 2000,
  }
  const run: Run = {
    id: "routine-run",
    botId: bot.id,
    threadId: thread.id,
    provider: bot.provider,
    trigger: "routine",
    requestMessageId: prompt.id,
    replyMessageId: reply.id,
    externalTurnId: null,
    status: "succeeded",
    errorClass: null,
    errorMessage: null,
    usage: null,
    routineRunId: "routine-slot",
    queuedAt: 1000,
    startedAt: 1000,
    finishedAt: 2000,
  }
  const onSend = vi.fn(async () => undefined)
  const props = {
    api,
    bot,
    thread: { ...thread, activeLeafId: reply.id },
    messages: [prompt, reply],
    runs: [run],
    computerGrant: null,
    onSend,
    onRetry: vi.fn(async () => undefined),
    onCancel: vi.fn(async () => undefined),
    onSwitchBranch: vi.fn(async () => undefined),
    onComputerGrant: vi.fn(),
    onOpenTools: vi.fn(),
    onRepeatTask: vi.fn(),
  }
  return { props, prompt, reply, run }
}

const getGroupRoutineFixture = () => {
  const { props, prompt, reply, run } = getFixture()
  const rootRun: Run = { ...run, replyMessageId: null }
  const childRun: Run = {
    ...run,
    id: "member-run",
    trigger: "user",
    routineRunId: null,
    requestMessageId: "member-private-request",
  }
  const earlierReply: Message = {
    ...reply,
    id: "earlier-member-reply",
    text: "Já conferi os itens urgentes.",
    parts: [],
    createdAt: 1500,
  }
  const memberReply: Message = {
    ...reply,
    parentId: earlierReply.id,
    runId: childRun.id,
    sender: { id: props.bot.id, name: props.bot.name },
  }

  return {
    props: { ...props, messages: [prompt, earlierReply, memberReply], runs: [rootRun, childRun] },
    prompt,
    memberReply,
    childRun,
  }
}

it("collapses only routine instructions and keeps the complete original available for editing", async () => {
  const { props, prompt } = getFixture()
  render(<ChatPanel {...props} thread={{ ...props.thread, kind: "routine" }} />)

  const toggle = screen.getByRole("button", { name: "Instruções da rotina" })
  expect(toggle).toHaveAttribute("aria-expanded", "false")
  const instructions = await screen.findByText("Leia as mensagens novas.")
  expect(instructions.closest(".disclosure-reveal")).toHaveAttribute("aria-hidden", "true")
  expect(screen.getByRole("button", { name: "Editar", exact: true })).toBeVisible()

  fireEvent.click(toggle)

  expect(toggle).toHaveAttribute("aria-expanded", "true")
  expect(screen.getByText("Leia as mensagens novas.")).toBeVisible()
  expect(screen.getByText("Ignore promoções e mantenha a caixa intacta.")).toBeVisible()

  fireEvent.click(toggle)
  fireEvent.click(screen.getByRole("button", { name: "Editar", exact: true }))

  expect(screen.getByRole("textbox", { name: "Editar mensagem" })).toHaveValue(prompt.text)
})

it.each(["NO_NOTIFICATION", "NO_REPLY", "NO_UPDATES", "NO_NEWS", "NO_ALERTS"])(
  "renders the final routine sentinel %s as a muted no-news result without changing history",
  (sentinel) => {
    const { props, prompt, reply } = getFixture()
    const message = { ...reply, text: `\n${sentinel}\n`, parts: [] }

    const view = render(<ChatPanel {...props} messages={[prompt, message]} />)

    expect(screen.getByText("Sem novidades nesta execução")).toHaveClass("routine-empty-result")
    expect(view.container.textContent).not.toContain(sentinel)
    expect(message.text).toBe(`\n${sentinel}\n`)
  },
)

it("preserves commentary and activity before a final no-news sentinel", () => {
  const { props, prompt, reply } = getFixture()
  const message: Message = {
    ...reply,
    text: "",
    parts: [
      { type: "text", text: "Vou conferir as mensagens novas." },
      { type: "reasoning", text: "Conferindo os resultados." },
      { type: "text", text: "NO_NOTIFICATION" },
    ],
  }

  render(<ChatPanel {...props} messages={[prompt, message]} />)

  expect(screen.getByText("Vou conferir as mensagens novas.")).toBeVisible()
  expect(screen.getByText("Sem novidades nesta execução")).toBeVisible()
  expect(screen.getByRole("button", { name: /Trabalhou por/ })).toBeVisible()
})

it("preserves a sentinel in an earlier text segment when the final answer contains news", () => {
  const { props, reply } = getFixture()
  const message: Message = {
    ...reply,
    text: "",
    parts: [
      { type: "text", text: "NO_NOTIFICATION" },
      { type: "reasoning", text: "Conferindo mais uma mensagem." },
      { type: "text", text: "Há uma mensagem que precisa de atenção." },
    ],
  }

  render(<ChatPanel {...props} messages={[message]} />)

  expect(screen.getByText("NO_NOTIFICATION", { exact: true })).toBeVisible()
  expect(screen.getByText("Há uma mensagem que precisa de atenção.")).toBeVisible()
  expect(screen.queryByText("Sem novidades nesta execução")).toBeNull()
})

it("recognizes a mirrored group member result through the nearest shared routine request", () => {
  const { props } = getGroupRoutineFixture()

  const view = render(<ChatPanel {...props} />)

  expect(screen.getByText("Já conferi os itens urgentes.")).toBeVisible()
  expect(screen.getByText("Sem novidades nesta execução")).toBeVisible()
  expect(view.container.textContent).not.toContain("NO_NOTIFICATION")
})

it("preserves a group member token after a later human follow-up", () => {
  const { props, prompt, memberReply, childRun } = getGroupRoutineFixture()
  const followUp: Message = {
    ...prompt,
    id: "human-follow-up",
    parentId: memberReply.id,
    text: "Explique o código NO_NOTIFICATION.",
    createdAt: 3000,
  }
  const followUpReply: Message = {
    ...memberReply,
    id: "human-follow-up-reply",
    parentId: followUp.id,
    runId: "human-follow-up-run",
    createdAt: 4000,
  }
  const followUpRun: Run = {
    ...childRun,
    id: "human-follow-up-run",
    requestMessageId: "human-private-request",
    replyMessageId: followUpReply.id,
  }

  render(
    <ChatPanel
      {...props}
      thread={{ ...props.thread, activeLeafId: followUpReply.id }}
      messages={[...props.messages, followUp, followUpReply]}
      runs={[...props.runs, followUpRun]}
    />,
  )

  expect(screen.getByText("NO_NOTIFICATION", { exact: true })).toBeVisible()
  expect(screen.getAllByText("Sem novidades nesta execução")).toHaveLength(1)
})

it.each(["missing", "cycle", "other-thread"])("stops group ancestry lookup with %s history", (history) => {
  const { props, prompt, memberReply } = getGroupRoutineFixture()
  const parentId = history === "cycle" ? memberReply.id : "missing-parent"
  const messages = history === "other-thread" ? [{ ...prompt, threadId: "other-thread" }] : [prompt]
  const message: Message = { ...memberReply, parentId: history === "other-thread" ? prompt.id : parentId }

  const routineRun = getRoutineReplyRun(message, props.runs, [...messages, message])

  expect(routineRun).toBeUndefined()
})

it.each(["O resultado foi NO_NOTIFICATION.", "`NO_NOTIFICATION`", "NO_PERMISSION", "NO_NOTIFICATION\nOutra mensagem"])(
  "preserves ordinary prose, quoted tokens and errors: %s",
  (text) => {
    const { props, reply } = getFixture()

    const view = render(<ChatPanel {...props} messages={[{ ...reply, text, parts: [] }]} />)

    expect(screen.queryByText("Sem novidades nesta execução")).toBeNull()
    expect(view.container.textContent?.replace(/\s+/g, " ")).toContain(text.replaceAll("`", "").replace(/\s+/g, " "))
  },
)

it("does not mask a streaming routine reply", () => {
  const { props, reply, run } = getFixture()

  render(<ChatPanel {...props} messages={[{ ...reply, status: "streaming" }]} runs={[{ ...run, status: "running" }]} />)

  expect(screen.getByText("NO_NOTIFICATION")).toBeVisible()
  expect(screen.queryByText("Sem novidades nesta execução")).toBeNull()
})

it("does not mask a complete reply from an unsuccessful run", () => {
  const { props, run } = getFixture()

  render(<ChatPanel {...props} runs={[{ ...run, status: "failed" }]} />)

  expect(screen.getByText("NO_NOTIFICATION")).toBeVisible()
  expect(screen.queryByText("Sem novidades nesta execução")).toBeNull()
})

it("leaves ordinary conversations expanded and still offers scheduling", async () => {
  const { props, run } = getFixture()
  const ordinaryRun: Run = { ...run, trigger: "user", routineRunId: null }

  render(<ChatPanel {...props} runs={[ordinaryRun]} />)

  expect(screen.queryByRole("button", { name: "Instruções da rotina" })).toBeNull()
  expect(await screen.findByText("Leia as mensagens novas.")).toBeVisible()
  expect(screen.getByText("NO_NOTIFICATION")).toBeVisible()
  expect(screen.getByRole("button", { name: "Agendar esta tarefa" })).toBeVisible()
})

it("hides the schedule suggestion for an existing routine execution", () => {
  const { props, reply } = getFixture()

  render(<ChatPanel {...props} messages={[{ ...reply, text: "Resumo pronto.", parts: [] }]} />)

  expect(screen.getByText("Resumo pronto.")).toBeVisible()
  expect(screen.queryByRole("button", { name: "Agendar esta tarefa" })).toBeNull()
  expect(screen.queryByRole("region", { name: "Continuar até concluir" })).toBeNull()
  expect(screen.getByText("Concluído")).toBeVisible()
  expect(screen.queryByText("A rotina terminou e deixou o resultado nesta conversa.")).toBeNull()
})

it("recognizes routine threads before run history loads", () => {
  const { props } = getFixture()

  render(<ChatPanel {...props} thread={{ ...props.thread, kind: "routine", routineRunId: "routine-slot" }} runs={[]} />)

  expect(screen.queryByRole("button", { name: "Agendar esta tarefa" })).toBeNull()
  expect(screen.queryByRole("region", { name: "Continuar até concluir" })).toBeNull()
})

it("does not collapse a later human follow-up in a routine thread", () => {
  const { props, prompt } = getFixture()
  const followUp: Message = { ...prompt, id: "human-follow-up", text: "Mostre os detalhes da última mensagem." }

  render(
    <VirtualMessageList
      messages={[followUp]}
      runs={props.runs}
      onRetry={props.onRetry}
      onSwitchBranch={props.onSwitchBranch}
    />,
  )

  expect(screen.getByText(followUp.text)).toBeVisible()
  expect(screen.queryByRole("button", { name: "Instruções da rotina" })).toBeNull()
})

it("labels routine turns shared into the main conversation and keeps the main conversation ordinary", () => {
  const { props, run } = getFixture()
  const routine: Routine = {
    id: "routine-slot",
    botId: props.bot.id,
    name: "Daily check",
    prompt: "Leia as mensagens novas.",
    cron: "0 9 * * *",
    timezone: "America/Sao_Paulo",
    enabled: true,
    continuity: "main-thread",
    resultsThreadId: null,
    groupId: null,
    timeoutMinutes: 30,
    overlap: "skip",
    catchUpMinutes: 30,
    nextRunAt: null,
    source: "local",
    createdAt: 1000,
    updatedAt: 1000,
  }
  const routineRun: RoutineRun = {
    id: routine.id,
    routineId: routine.id,
    scheduledFor: Date.UTC(2026, 8, 22, 12),
    status: "succeeded",
    threadId: props.thread.id,
    runId: run.id,
    triggerSource: "manual",
    summary: "Resumo pronto.",
    startedAt: 1000,
    finishedAt: 2000,
  }

  render(
    <ChatPanel
      {...props}
      thread={{ ...props.thread, kind: "main" }}
      runs={[{ ...run, routineRunId: routineRun.id }]}
      routines={[routine]}
      routineRuns={[routineRun]}
    />,
  )

  expect(screen.getByText(/Daily check · Manual ·/)).toBeVisible()
  expect(screen.queryByRole("button", { name: "Instruções da rotina" })).toBeNull()
  expect(screen.getByText("Leia as mensagens novas.")).toBeVisible()
})

it("keeps automatic run headers when deleted routine metadata is absent", () => {
  const { props } = getFixture()

  const { container } = render(<ChatPanel {...props} thread={{ ...props.thread, kind: "main" }} />)

  expect(container.querySelector(".routine-run-header")).toHaveTextContent(/^Rotina · Automática ·/)
  expect(screen.queryByRole("button", { name: "Instruções da rotina" })).toBeNull()
})

it("provides Portuguese and English routine copy", () => {
  expect(t("Instruções da rotina", {}, "en")).toBe("Routine instructions")
  expect(t("Sem novidades nesta execução", {}, "en")).toBe("Nothing new this run")
  expect(t("Uma conversa nova por tarefa", {}, "en")).toBe("A new conversation for each task")
})
