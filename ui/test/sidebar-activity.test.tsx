import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import type { Bot, Message, Run, Thread } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { computeBotActivity, holdBotPositions, orderBotsByActivity } from "../src/botActivity"
import { Sidebar } from "../src/components/BotSidebar"
import { SettingsModal } from "../src/components/Modals"
import { t } from "../src/i18n"
import { readWorkspaceState, saveWorkspaceState } from "../src/workspaceState"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete document.documentElement.dataset.motion
})

const T0 = 1_000_000

const makeBot = (base: Bot, id: string, name: string, sortOrder: number): Bot => ({
  ...base,
  id,
  name,
  sortOrder,
  paused: false,
  avatarSeed: name,
})

const makeThread = (base: Thread, id: string, botId: string, patch: Partial<Thread> = {}): Thread => ({
  ...base,
  id,
  botId,
  title: `Conversa ${botId}`,
  unread: 0,
  createdAt: T0,
  updatedAt: T0,
  ...patch,
})

const makeMessage = (base: Message, id: string, threadId: string, patch: Partial<Message> = {}): Message => ({
  ...base,
  id,
  threadId,
  role: "assistant",
  status: "complete",
  text: `Resposta ${id}`,
  parts: [{ type: "text", text: `Resposta ${id}` }],
  createdAt: T0,
  updatedAt: T0,
  ...patch,
})

const run = (id: string, botId: string, threadId: string, status: Run["status"] = "running"): Run => ({
  id,
  botId,
  threadId,
  provider: "codex",
  trigger: "user",
  status,
  routineRunId: null,
  requestMessageId: null,
  replyMessageId: null,
  externalTurnId: null,
  errorClass: null,
  errorMessage: null,
  usage: null,
  queuedAt: T0,
  startedAt: T0 + 50,
  finishedAt: null,
})

/** Four bots in manual order alfa, beta, gama, delta; each with one idle conversation. */
const fixture = () => {
  const state = createMockApi().getState()
  const [botBase] = state.bots
  const [threadBase] = state.threads
  const [messageBase] = state.messages
  if (!botBase || !threadBase || !messageBase) throw new Error("Fixture indisponível")
  const bots = ["alfa", "beta", "gama", "delta"].map((name, index) => makeBot(botBase, `bot-${name}`, name, index))
  const threads = bots.map((bot) => makeThread(threadBase, `thread-${bot.name}`, bot.id))
  return { bots, threads, messageBase }
}

const pendingApproval = (base: Message, threadId: string, at: number): Message =>
  makeMessage(base, `approval-${threadId}`, threadId, {
    kind: "approval",
    createdAt: at,
    updatedAt: at,
    parts: [
      {
        type: "approval",
        approvalId: `approval-${threadId}`,
        request: "permission",
        detail: "Executar comando",
        decision: "pending",
        allowStanding: false,
      },
    ],
  })

type SidebarOverrides = Partial<Parameters<typeof Sidebar>[0]>

const renderSidebar = (overrides: SidebarOverrides & { bots: Array<Bot>; threads: Array<Thread> }) => {
  const props: Parameters<typeof Sidebar>[0] = {
    showFakeTrafficLights: false,
    messages: [],
    runs: [],
    selectedBotId: null,
    selectedThreadId: null,
    section: "bots",
    advancedPage: null,
    onRoutines: () => undefined,
    onProject: () => undefined,
    onImport: () => undefined,
    onChat: () => undefined,
    onAdvancedPage: () => undefined,
    onSelect: () => undefined,
    onSelectThread: () => undefined,
    onReviewApproval: () => undefined,
    onNewThread: () => undefined,
    onNewBot: () => undefined,
    onBotSettings: () => undefined,
    onSettings: () => undefined,
    onDoctor: () => undefined,
    onSearch: () => undefined,
    notifications: [],
    onNotificationsOpen: () => undefined,
    notificationActions: {
      open: () => undefined,
      dismiss: async () => undefined,
      dismissAll: async () => undefined,
      respond: async () => undefined,
      reply: async () => undefined,
    },
    ...overrides,
  }
  const view = render(<Sidebar {...props} />)
  return {
    ...view,
    update: (patch: SidebarOverrides) => view.rerender(<Sidebar {...props} {...patch} />),
  }
}

const order = (): Array<string> =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-bot-entry]")).map((entry) => entry.dataset.botEntry ?? "")

it("hides the work summary when no runs are active or queued", () => {
  const { bots, threads } = fixture()

  renderSidebar({ bots, threads, workRuns: [] })

  expect(document.querySelector(".sidebar-work-badge")).toBeNull()
})

it("keeps only hidden unread messages on an expanded bot and restores its total when collapsed", () => {
  const { bots, threads } = fixture()
  const bot = bots[0]
  const baseThread = threads[0]
  if (!bot || !baseThread) throw new Error("Missing unread fixture")
  const visible = makeThread(baseThread, "visible-thread", bot.id, { unread: 2 })
  const archived = makeThread(baseThread, "archived-thread", bot.id, { unread: 3, archivedAt: T0 })
  const grouped = makeThread(baseThread, "group-thread", bot.id, { unread: 4, groupId: "test-group" })

  const view = renderSidebar({ bots: [bot], threads: [visible, archived, grouped], selectedBotId: bot.id })

  expect(screen.getByRole("img", { name: "7 mensagens não lidas" })).toBeVisible()
  expect(screen.getByRole("img", { name: "2 mensagens não lidas" })).toBeVisible()
  expect(document.querySelectorAll(".thread-row")).toHaveLength(1)

  view.update({ selectedBotId: null })

  expect(screen.getByRole("img", { name: "9 mensagens não lidas" })).toBeVisible()
  expect(document.querySelector(".bot-thread-tree")).toBeNull()
})

it("shows active work as a clear navigation action in both languages", () => {
  const { bots, threads } = fixture()
  const running = run("run-active", "bot-alfa", "thread-alfa")
  const queued = run("run-queued", "bot-beta", "thread-beta", "queued")

  renderSidebar({ bots, threads, workRuns: [running, queued] })

  const badge = screen.getByRole("button", { name: "Ver trabalho: 1 em execução, 1 na fila", exact: true })
  expect(badge).toHaveTextContent("Trabalhando 1")
  expect(badge).toHaveTextContent("1 na fila")
  expect(badge).toHaveTextContent("Ver trabalho")
  expect(t("View work", {}, "en")).toBe("View work")
  expect(t("View work summary", { running: 1, queued: 1 }, "en")).toBe("View work: 1 running, 1 queued")
})

const entry = (botId: string): HTMLElement => {
  const element = document.querySelector<HTMLElement>(`[data-bot-entry="${botId}"]`)
  if (!element) throw new Error(`Bot ${botId} ausente`)
  return element
}

it.each([
  {
    kind: "routine" as const,
    title: "Novas mensagens · 10/12/20, 7:04 PM",
    tooltip: "Novas mensagens · 12/10/2020, 19:04",
    dateLabel: /12\/10\/2020, 19:04/,
  },
  {
    kind: "chat" as const,
    title: "Novas mensagens · 12 de out., 19:00",
    tooltip: "Novas mensagens",
    dateLabel: /12 de out\./,
  },
])("keeps the generated $kind title concise and localizes its date label", ({ kind, title, tooltip, dateLabel }) => {
  const { bots, threads } = fixture()
  const bot = bots[0]
  const baseThread = threads[0]
  if (!bot || !baseThread) throw new Error("Fixture indisponível")
  const timestamp = new Date(2020, 9, 12, 19, 4).getTime()
  const thread = makeThread(baseThread, "thread-dated", bot.id, {
    kind,
    title,
    createdAt: timestamp,
    updatedAt: timestamp,
  })

  renderSidebar({
    bots: [bot],
    threads: [thread],
    selectedBotId: bot.id,
    routineRuns:
      kind === "routine"
        ? [
            {
              id: "sidebar-routine-run",
              routineId: "sidebar-routine",
              threadId: thread.id,
              scheduledFor: timestamp,
              status: "succeeded",
              runId: null,
              triggerSource: "cron",
              summary: null,
              startedAt: timestamp,
              finishedAt: timestamp,
            },
          ]
        : [],
  })

  const row = screen.getByRole("button", { name: /Novas mensagens/ })
  expect(row.querySelector("strong")).toHaveTextContent(/^Novas mensagens$/)
  expect(row.querySelector("strong")).toHaveAttribute("title", tooltip)
  expect(row.querySelector("small")).toHaveTextContent(dateLabel)
  expect(thread.title).toBe(title)
})

it("orders needs-you, then working, then unread, then the manual order, newest first inside a tier", () => {
  const { bots, threads, messageBase } = fixture()
  const unreadThreads = threads.map((thread) =>
    thread.botId === "bot-alfa" || thread.botId === "bot-beta" ? { ...thread, unread: 1 } : thread,
  )
  const activity = computeBotActivity({
    bots,
    threads: unreadThreads.map((thread) => (thread.botId === "bot-beta" ? { ...thread, updatedAt: T0 + 900 } : thread)),
    messages: [pendingApproval(messageBase, "thread-delta", T0 + 10)],
    runs: [run("run-gama", "bot-gama", "thread-gama"), run("run-old", "bot-alfa", "thread-alfa", "succeeded")],
    attention: [],
    notifications: [],
    lastViewed: Object.fromEntries(bots.map((bot) => [bot.id, T0 + 10_000])),
    viewingBotId: null,
  })
  expect(activity.get("bot-delta")?.kind).toBe("needs-you")
  expect(activity.get("bot-gama")?.kind).toBe("working")
  expect(activity.get("bot-alfa")?.kind).toBe("new")
  expect(orderBotsByActivity({ botIds: bots.map((bot) => bot.id), activity })).toEqual([
    "bot-delta",
    "bot-gama",
    "bot-beta",
    "bot-alfa",
  ])
})

it("an answered approval or the bot on screen no longer floats; replies after the last view count as news", () => {
  const { bots, threads, messageBase } = fixture()
  const answered = pendingApproval(messageBase, "thread-delta", T0)
  const approved: Message = {
    ...answered,
    parts: answered.parts.map((part) => (part.type === "approval" ? { ...part, decision: "approved" } : part)),
  }
  const reply = makeMessage(messageBase, "reply-gama", "thread-gama", { updatedAt: T0 + 500 })
  const activity = (viewingBotId: string | null) =>
    computeBotActivity({
      bots,
      threads,
      messages: [approved, reply],
      runs: [],
      attention: [],
      notifications: [],
      lastViewed: Object.fromEntries(bots.map((bot) => [bot.id, T0 + 100])),
      viewingBotId,
    })
  expect(activity(null).get("bot-delta")?.kind).toBeNull()
  expect(activity(null).get("bot-gama")?.kind).toBe("new")
  expect(activity("bot-gama").get("bot-gama")?.kind).toBeNull()
  expect(holdBotPositions({ desired: ["b", "a", "c"], previous: ["a", "b", "c"], held: new Set(["a"]) })).toEqual([
    "a",
    "b",
    "c",
  ])
})

it("floats bots with updates to the top by default and labels each indicator", () => {
  const { bots, threads, messageBase } = fixture()
  renderSidebar({
    bots,
    threads: threads.map((thread) => (thread.botId === "bot-beta" ? { ...thread, unread: 2 } : thread)),
    messages: [pendingApproval(messageBase, "thread-delta", T0 + 10)],
    runs: [run("run-gama", "bot-gama", "thread-gama")],
  })
  expect(order()).toEqual(["bot-delta", "bot-gama", "bot-beta", "bot-alfa"])
  expect(screen.getByRole("img", { name: "delta: precisa de você" })).toBeVisible()
  expect(screen.getByRole("img", { name: "gama: trabalhando" })).toBeVisible()
  expect(screen.getByRole("img", { name: "beta: novidades" })).toBeVisible()
  expect(within(entry("bot-alfa")).queryByRole("img", { name: /alfa:/ })).toBeNull()
  expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
    "Precisa de você",
    "Trabalhando",
    "Ociosos",
  ])
  expect(within(entry("bot-delta")).getByText("Aguardando você: sua aprovação")).toBeVisible()
  expect(screen.getByRole("button", { name: "Notificações, 1 precisa de atenção" })).toBeVisible()
})

it("with the setting off, keeps manual order inside the required status groups", () => {
  const { bots, threads, messageBase } = fixture()
  renderSidebar({
    bots,
    threads,
    floatUpdates: false,
    messages: [pendingApproval(messageBase, "thread-delta", T0 + 10)],
    runs: [run("run-gama", "bot-gama", "thread-gama")],
  })
  expect(order()).toEqual(["bot-delta", "bot-gama", "bot-alfa", "bot-beta"])
  expect(screen.getByRole("img", { name: "delta: precisa de você" })).toBeVisible()
  expect(screen.getByRole("img", { name: "gama: trabalhando" })).toBeVisible()
})

it("keeps the waiting line and bell in sync for questions, failures and resolved approvals", () => {
  const { bots, threads, messageBase } = fixture()
  const api = createMockApi()
  const approval = pendingApproval(messageBase, "thread-delta", T0)
  const question = api.notify({
    kind: "question",
    botId: "bot-alfa",
    threadId: "thread-alfa",
    title: "Uma pergunta",
    body: "Qual pasta?",
  })
  const failure = api.notify({
    kind: "turn-failed",
    botId: "bot-beta",
    threadId: "thread-beta",
    title: "Tarefa interrompida",
    body: "Tente novamente.",
  })
  const approvalNotice = api.notify({
    kind: "approval",
    botId: "bot-delta",
    threadId: "thread-delta",
    requestId: "approval-thread-delta",
    title: "Permissão",
    body: "Executar comando",
  })
  const view = renderSidebar({
    bots,
    threads,
    messages: [approval],
    notifications: [question, failure, approvalNotice],
  })
  expect(screen.getByRole("button", { name: "Notificações, 3 precisam de atenção" })).toBeVisible()
  expect(within(entry("bot-alfa")).getByText("Aguardando você: sua resposta")).toBeVisible()
  expect(within(entry("bot-beta")).getByText("Aguardando você: revise a tarefa interrompida")).toBeVisible()
  expect(within(entry("bot-delta")).getByText("Aguardando você: sua aprovação")).toBeVisible()
  view.update({ notifications: [question, failure, { ...approvalNotice, resolvedAt: T0 + 100, resolution: "allow" }] })
  expect(screen.getByRole("button", { name: "Notificações, 2 precisam de atenção" })).toBeVisible()
  expect(within(entry("bot-delta")).queryByText(/Aguardando você:/)).toBeNull()
  expect(entry("bot-delta")).not.toHaveAttribute("data-activity", "needs-you")
})

it.each(["failed", "succeeded"] as const)("clears failure attention during a retry that later %s", (outcome) => {
  const { bots, threads, messageBase } = fixture()
  const api = createMockApi()
  const failure = {
    ...api.notify({
      kind: "turn-failed",
      botId: "bot-beta",
      threadId: "thread-beta",
      title: "Tarefa interrompida",
      body: "Tente novamente.",
    }),
    createdAt: T0 + 100,
  }
  const failedRun = {
    ...run("failed-run", "bot-beta", "thread-beta", "failed"),
    finishedAt: failure.createdAt,
  }
  const reply = makeMessage(messageBase, "failed-reply", "thread-beta", {
    status: "failed",
    runId: failedRun.id,
    updatedAt: failure.createdAt,
  })
  const view = renderSidebar({ bots, threads, messages: [reply], runs: [failedRun], notifications: [failure] })
  expect(entry("bot-beta")).toHaveAttribute("data-activity", "needs-you")
  expect(within(entry("bot-beta")).getByText("Aguardando você: revise a tarefa interrompida")).toBeVisible()
  expect(screen.getByRole("button", { name: "Notificações, 1 precisa de atenção" })).toBeVisible()

  const retry = {
    ...run("retry-run", "bot-beta", "thread-beta", "queued"),
    trigger: "retry" as const,
    queuedAt: T0 + 200,
    startedAt: null,
  }
  for (const status of ["queued", "starting", "running"] as const) {
    view.update({ runs: [failedRun, { ...retry, status }] })
    expect(entry("bot-beta")).toHaveAttribute("data-activity", "working")
    expect(entry("bot-beta").querySelector(".bot-row")).toHaveAttribute("data-attention", "running")
    expect(within(entry("bot-beta")).queryByText(/Aguardando você:|Resposta interrompida/)).toBeNull()
    expect(screen.getByRole("button", { name: "Notificações", exact: true })).toBeVisible()
  }

  const finishedAt = T0 + 300
  view.update({
    runs: [failedRun, { ...retry, status: outcome, finishedAt }],
    notifications:
      outcome === "failed" ? [failure, { ...failure, id: failure.id + 1, createdAt: finishedAt }] : [failure],
  })
  if (outcome === "failed") {
    expect(entry("bot-beta")).toHaveAttribute("data-activity", "needs-you")
    expect(screen.getByRole("button", { name: "Notificações, 1 precisa de atenção" })).toBeVisible()
  } else {
    expect(entry("bot-beta")).not.toHaveAttribute("data-activity", "needs-you")
    expect(within(entry("bot-beta")).queryByText(/Aguardando você:|Resposta interrompida/)).toBeNull()
    expect(screen.getByRole("button", { name: "Notificações", exact: true })).toBeVisible()
  }
})

it("shows interrupted tasks only while pending and leaves the count on the notification bell", () => {
  const { bots, threads } = fixture()
  const api = createMockApi()
  const failure = api.notify({
    kind: "turn-failed",
    botId: "bot-alfa",
    threadId: "thread-alfa",
    title: "Tarefa interrompida",
    body: "A resposta foi interrompida.",
  })
  const view = renderSidebar({ bots, threads, onRecovery: vi.fn(), recoveryCount: 0 })

  expect(screen.queryByRole("button", { name: /Tarefas interrompidas/ })).toBeNull()

  view.update({ recoveryCount: 1, notifications: [failure] })

  const recovery = screen.getByRole("button", { name: "Tarefas interrompidas", exact: true })
  expect(recovery.querySelector("svg")).not.toBeNull()
  expect(recovery).not.toHaveTextContent(/\d/)
  expect(screen.getByRole("button", { name: "Notificações, 1 precisa de atenção" })).toBeVisible()
  expect(screen.getAllByText("1", { selector: ".notification-badge" })).toHaveLength(1)
})

it("lets the bell open an approval that arrived before its notification", () => {
  const { bots, threads, messageBase } = fixture()
  const onReviewApproval = vi.fn()
  renderSidebar({ bots, threads, messages: [pendingApproval(messageBase, "thread-delta", T0)], onReviewApproval })
  fireEvent.click(screen.getByRole("button", { name: "Notificações, 1 precisa de atenção" }))
  fireEvent.click(screen.getByRole("button", { name: "Revisar aprovação pendente" }))
  expect(onReviewApproval).toHaveBeenCalledWith({ threadId: "thread-delta", approvalId: "approval-thread-delta" })
})

it("does not reorder a hovered or keyboard-focused bot within its status group", () => {
  const { bots, threads } = fixture()
  const view = renderSidebar({ bots, threads })
  expect(order()).toEqual(["bot-alfa", "bot-beta", "bot-gama", "bot-delta"])
  fireEvent.mouseEnter(entry("bot-alfa"))
  view.update({ threads: threads.map((thread) => (thread.botId === "bot-gama" ? { ...thread, unread: 1 } : thread)) })
  expect(order()).toEqual(["bot-alfa", "bot-gama", "bot-beta", "bot-delta"])
  fireEvent.mouseLeave(entry("bot-alfa"))
  expect(order()).toEqual(["bot-gama", "bot-alfa", "bot-beta", "bot-delta"])

  const button = within(entry("bot-alfa")).getAllByRole("button")[0]
  if (!button) throw new Error("Botão ausente")
  act(() => button.focus())
  view.update({
    threads: threads.map((thread) =>
      ["bot-gama", "bot-beta"].includes(thread.botId) ? { ...thread, unread: 1 } : thread,
    ),
  })
  expect(order().indexOf("bot-alfa")).toBe(1)
  act(() => button.blur())
  expect(order()).toEqual(["bot-beta", "bot-gama", "bot-alfa", "bot-delta"])
})

it("keeps the selected bot in place while the user types in its composer", () => {
  const { bots, threads } = fixture()
  const composer = document.createElement("div")
  composer.className = "composer"
  const textarea = document.createElement("textarea")
  composer.append(textarea)
  document.body.append(composer)
  try {
    const view = renderSidebar({ bots, threads, selectedBotId: "bot-alfa", selectedThreadId: "thread-alfa" })
    act(() => textarea.focus())
    view.update({
      threads: threads.map((thread) => (thread.botId === "bot-delta" ? { ...thread, unread: 1 } : thread)),
    })
    expect(order()).toEqual(["bot-alfa", "bot-delta", "bot-beta", "bot-gama"])
    act(() => textarea.blur())
    expect(order()).toEqual(["bot-delta", "bot-alfa", "bot-beta", "bot-gama"])
  } finally {
    composer.remove()
  }
})

it("marks a bot read once viewed and persists the last-viewed time", () => {
  const { bots, threads, messageBase } = fixture()
  saveWorkspaceState({ lastViewedByBot: Object.fromEntries(bots.map((bot) => [bot.id, T0 + 100])) })
  const reply = makeMessage(messageBase, "reply-beta", "thread-beta", { updatedAt: T0 + 500 })
  const view = renderSidebar({ bots, threads, messages: [reply] })
  expect(screen.getByRole("img", { name: "beta: novidades" })).toBeVisible()
  expect(order()[0]).toBe("bot-beta")
  view.update({ selectedBotId: "bot-beta", selectedThreadId: "thread-beta" })
  expect(screen.queryByRole("img", { name: "beta: novidades" })).toBeNull()
  expect(readWorkspaceState().lastViewedByBot?.["bot-beta"]).toBeGreaterThanOrEqual(T0 + 500)
  view.update({ selectedBotId: "bot-alfa", selectedThreadId: "thread-alfa" })
  expect(screen.queryByRole("img", { name: "beta: novidades" })).toBeNull()
})

const positionByIndex = () =>
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const index = this.parentElement
      ? Array.from(this.parentElement.querySelectorAll("[data-bot-entry]")).indexOf(this)
      : 0
    return {
      top: index * 50,
      bottom: index * 50 + 50,
      left: 0,
      right: 200,
      width: 200,
      height: 50,
      x: 0,
      y: index * 50,
      toJSON: () => ({}),
    }
  })

it("animates reordering with FLIP, and skips the animation when motion is reduced", () => {
  const { bots, threads } = fixture()
  positionByIndex()
  const view = renderSidebar({ bots, threads })
  view.update({ runs: [run("run-delta", "bot-delta", "thread-delta")] })
  expect(order()[0]).toBe("bot-delta")
  expect(entry("bot-delta").style.transform).toBe("translateY(150px)")
  expect(entry("bot-alfa").style.transform).toBe("translateY(-50px)")
  cleanup()

  document.documentElement.dataset.motion = "reduce"
  const reduced = renderSidebar({ bots, threads })
  reduced.update({ runs: [run("run-delta", "bot-delta", "thread-delta")] })
  expect(order()[0]).toBe("bot-delta")
  expect(entry("bot-delta").style.transform).toBe("")
  expect(entry("bot-delta").dataset.reordering).toBeUndefined()
})

it("the setting is on by default and saving it off persists through the settings API", async () => {
  const onSave = vi.fn(async () => undefined)
  render(<SettingsModal settings={null} onClose={() => undefined} onSave={onSave} />)
  fireEvent.click(screen.getByText("Chat, barra lateral e atalhos"))
  const toggle = screen.getByRole("switch", { name: "Mover bots com novidades para o topo" })
  expect(toggle).toBeChecked()
  fireEvent.click(toggle)
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Salvar preferências" })))
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ sidebarFloatUpdates: false }))
})
