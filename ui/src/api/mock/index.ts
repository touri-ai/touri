import type {
  ApiModel,
  ApiRoutes,
  Bot,
  BotGroup,
  BotLearning,
  BrowserTabInfo,
  DoctorReport,
  Goal,
  GroupInput,
  Id,
  ImportReport,
  McpServer,
  Message,
  NotificationRecord,
  ProcessRunState,
  ProcessSpec,
  Project,
  RecoveryTask,
  Routine,
  RoutineRun,
  Run,
  TelegramIntegration,
  Thread,
  UiEvent,
  UiEventEnvelope,
} from "@touri/contracts"
import { toolCatalog } from "@touri/contracts"
import { avatarColorFor, avatarShapeFor } from "@touri/contracts/avatar"
import rootPackage from "../../../../package.json"
import seedJson from "../../../../sidecar/test/fixtures/ui-seed.json"
import { ApiError } from "../../errors"
import type { ApiRequest, UiApi } from "../client"

type Seed = {
  bots: Array<{ id: string; name: string; provider: "codex" | "claude" | "opencode"; paused: boolean; unread: number }>
  threads: Array<{ id: string; botId: string; title: string; running: boolean }>
  messages: Array<{ id: string; threadId: string; role: "user" | "assistant"; text: string }>
}

type ProcessEntry = { spec: ProcessSpec; run: ProcessRunState | null }

type MockCall = { route: string; input: unknown; pathValues: Record<string, string> }

type MockApi = UiApi & {
  calls: Array<MockCall>
  emit: (event: UiEvent) => void
  notify: (
    input: Pick<NotificationRecord, "kind" | "title" | "body"> & Partial<NotificationRecord>,
  ) => NotificationRecord
  getState: () => { bots: Array<Bot>; threads: Array<Thread>; messages: Array<Message> }
}

const seed = seedJson as Seed
const now = (): number => Date.now()

const createBot = (input: Seed["bots"][number], index: number, projectId: Id | null): Bot => ({
  id: input.id,
  name: input.name,
  title: input.name === "mark" ? "Campaign lead" : input.name === "onb" ? "Operations" : "Research",
  description: "A persistent local teammate.",
  color: null,
  avatarSeed: input.name,
  avatarPath: null,
  instructions: `Você é ${input.name}, um colega local atencioso. Responda em pt-BR desde a primeira mensagem, ou no idioma solicitado pelo usuário.`,
  instructionsHash: "mock",
  provider: input.provider,
  model: null,
  reasoningEffort: "medium",
  access: "workspace-write",
  approvals: "on-request",
  projectId,
  cwd: null,
  folders: [],
  anyFolderAccess: false,
  homeDir: `/Users/demo/Library/Application Support/touri/bots/${input.id}`,
  mainThreadId: null,
  browserEnabled: true,
  browser: "touri",
  computerUse: false,
  machine: "local",
  machineIdleMinutes: 10,
  vmProviderLogin: false,
  providerProfile: null,
  claudeAiConnectors: false,
  hostComputerUse: false,
  notifications: "failures",
  section: index === 2 ? "Later" : "Team",
  sortOrder: index,
  paused: input.paused,
  source: "local",
  createdAt: now(),
  updatedAt: now(),
  archivedAt: null,
})

const createThread = (input: Seed["threads"][number]): Thread => ({
  id: input.id,
  botId: input.botId,
  parentThreadId: null,
  kind: "main",
  title: input.title,
  activeLeafId: null,
  routineRunId: null,
  cwdOverride: null,
  unread: input.botId === "bot-mark" ? 2 : 0,
  carryoverNote: null,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costUsd: null,
    turns: 0,
    contextTokens: null,
    contextWindow: null,
  },
  source: "local",
  createdAt: now(),
  updatedAt: now(),
  archivedAt: null,
})

const createMessage = ({
  id,
  threadId,
  role,
  text,
  status = "complete",
  runId = null,
  parentId = null,
}: {
  id: string
  threadId: string
  role: Message["role"]
  text: string
  status?: Message["status"]
  runId?: string | null
  parentId?: string | null
}): Message => ({
  id,
  threadId,
  parentId,
  role,
  kind: role === "assistant" ? "text" : "text",
  status,
  runId,
  text,
  parts: [{ type: "text", text }],
  sender: null,
  source: "local",
  createdAt: now(),
  updatedAt: now(),
})

const createRun = ({
  id,
  threadId,
  botId,
  status = "succeeded",
  errorClass = null,
}: {
  id: string
  threadId: string
  botId: string
  status?: Run["status"]
  errorClass?: Run["errorClass"]
}): Run => ({
  id,
  threadId,
  botId,
  provider: "codex",
  trigger: "user",
  origin: "message",
  requestMessageId: null,
  replyMessageId: null,
  externalTurnId: null,
  status,
  errorClass,
  errorMessage: errorClass ? "The local provider stopped before completing this turn." : null,
  usage: null,
  routineRunId: null,
  queuedAt: now(),
  startedAt: status === "queued" ? null : now(),
  finishedAt: status === "succeeded" || status === "failed" ? now() : null,
})

const createProject = (): Project => ({
  id: "project-demo",
  name: "touri demo workspace",
  path: "/Users/demo/javascript/touri-demo",
  gitRemote: "git@github.com:touri/demo.git",
  defaultBranch: "main",
  dataDir: "/Users/demo/Library/Application Support/touri/projects/project-demo",
  createdAt: now(),
  updatedAt: now(),
  archivedAt: null,
})

const createProcesses = (project: Project): Array<ProcessEntry> => {
  const make = (name: string, command: string, previewPort: number | null): ProcessEntry => ({
    spec: {
      id: `process-${name}`,
      projectId: project.id,
      name,
      command,
      cwd: project.path,
      env: {},
      autostart: name === "web",
      restart: "on-failure",
      dependsOn: [],
      ready: previewPort ? { port: previewPort } : null,
      previewPort,
      createdBy: "user",
      createdAt: now(),
      updatedAt: now(),
    },
    run: null,
  })
  return [make("web", "pnpm dev", 4310), make("worker", "pnpm worker", null)]
}

const createRoutine = (botId: string): Routine => ({
  id: "routine-daily",
  botId,
  name: "Daily brief",
  prompt: "Summarize the open work and suggest the next smallest step.",
  cron: "0 9 * * 1-5",
  timezone: "America/Sao_Paulo",
  enabled: false,
  continuity: "main-thread",
  resultsThreadId: null,
  groupId: null,
  timeoutMinutes: 30,
  overlap: "skip",
  catchUpMinutes: 30,
  nextRunAt: null,
  source: "local",
  createdAt: now(),
  updatedAt: now(),
})

const createBrowserTab = (): BrowserTabInfo & { ownerBotId: Id | null } => ({
  tabId: "tab-demo",
  url: "https://example.com/agent-home",
  title: "Agent workspace",
  state: "live",
  openerTabId: null,
  heldByUser: false,
  lastUsedAt: now(),
  ownerBotId: "bot-mark",
})

const defaultDoctor: DoctorReport = {
  running: false,
  checkedAt: now(),
  checks: [
    { id: "codex", label: "codex · versão", status: "pass", ok: true, detail: "Codex 0.42 disponível.", fix: null },
    { id: "claude", label: "claude · autenticação", status: "pass", ok: true, detail: "Login confirmado.", fix: null },
    {
      id: "shell-env",
      label: "Shell · ambiente",
      status: "pass",
      ok: true,
      detail: "PATH do shell de login carregado.",
      fix: null,
    },
    { id: "git", label: "git", status: "pass", ok: true, detail: "Disponível em /usr/bin/git.", fix: null },
    { id: "node", label: "node", status: "pass", ok: true, detail: "Node 22.12 disponível.", fix: null },
  ],
}

/** Optional demo states for screenshots and manual review, selected with `?mockScenario=` in the mock UI. */
export type MockScenario = "resumed-turn" | "routine-conversation" | "interrupted-tasks"

export const getRoutineConversationFixture = (): {
  thread: Thread
  messages: Array<Message>
  run: Run
  routine: Routine
  routineRun: RoutineRun
} => {
  const startedAt = Date.UTC(2026, 9, 17, 19, 4)
  const finishedAt = startedAt + 35_000
  const prompt = [
    "Confira as mensagens recebidas desde a última execução e procure apenas assuntos que precisam de atenção hoje.",
    "Ignore recibos automáticos, anúncios e mensagens já resolvidas. Não envie respostas nem altere a caixa de entrada.",
    "Se houver algo importante, traga um resumo curto e indique o próximo passo. Se não houver novidades, responda apenas NO_NOTIFICATION.",
  ].join("\n\n")
  const request: Message = {
    ...createMessage({ id: "m-routine-request", threadId: "thread-mark", role: "user", text: prompt }),
    createdAt: startedAt,
    updatedAt: startedAt,
  }
  const commentary = "Vou conferir as mensagens recentes e separar o que precisa de atenção."
  const reply: Message = {
    ...createMessage({
      id: "m-routine-reply",
      threadId: request.threadId,
      role: "assistant",
      text: `${commentary}\n\nNO_NOTIFICATION`,
      parentId: request.id,
      runId: "run-inbox-summary",
    }),
    parts: [
      { type: "text", text: commentary },
      {
        type: "tool_call",
        callId: "call-inbox-summary",
        tool: "inbox.read",
        summary: "Conferir mensagens recentes",
        inputJson: '{"folder":"inbox","unreadOnly":true}',
        outputJson: '{"checked":12,"needsAttention":0}',
        ok: true,
        resolution: "succeeded",
        startedAt: startedAt + 5_000,
        resolvedAt: finishedAt - 5_000,
      },
      { type: "text", text: "NO_NOTIFICATION" },
    ],
    createdAt: startedAt + 1_000,
    updatedAt: finishedAt,
  }
  const routine: Routine = {
    ...createRoutine("bot-mark"),
    id: "routine-inbox-summary",
    name: "Resumo da caixa de entrada",
    prompt,
    cron: "0 9,14,19 * * *",
    enabled: true,
    continuity: "new-thread",
    createdAt: startedAt - 5 * 86_400_000,
    updatedAt: startedAt,
  }
  const routineRun: RoutineRun = {
    id: "routine-run-inbox-summary",
    routineId: routine.id,
    scheduledFor: startedAt,
    status: "succeeded",
    threadId: request.threadId,
    runId: reply.runId,
    triggerSource: "cron",
    summary: "NO_NOTIFICATION",
    startedAt,
    finishedAt,
  }
  const run: Run = {
    ...createRun({ id: "run-inbox-summary", threadId: request.threadId, botId: routine.botId }),
    trigger: "routine",
    requestMessageId: request.id,
    replyMessageId: reply.id,
    routineRunId: routineRun.id,
    queuedAt: startedAt,
    startedAt,
    finishedAt,
  }
  const thread: Thread = {
    ...createThread({
      id: request.threadId,
      botId: routine.botId,
      title: `${routine.name} · 10/17/26, 7:04 PM`,
      running: false,
    }),
    kind: "routine",
    activeLeafId: reply.id,
    routineRunId: routineRun.id,
    unread: 0,
    createdAt: routine.createdAt,
    updatedAt: finishedAt,
  }

  return { thread, messages: [request, reply], run, routine, routineRun }
}

const resumedTurnFixture = (): { messages: Array<Message>; runs: Array<Run> } => {
  const request = createMessage({
    id: "m-resume-request",
    threadId: "thread-mark",
    role: "user",
    text: "Atualize o relatório da campanha com os números de ontem e publique o rascunho.",
    parentId: "m2",
  })
  const partialText = "Baixei os números de ontem e comecei a atualizar a tabela de conversões."
  const partial: Message = {
    ...createMessage({
      id: "m-resume-partial",
      threadId: "thread-mark",
      role: "assistant",
      text: partialText,
      status: "failed",
      runId: "run-interrupted",
      parentId: request.id,
    }),
    parts: [
      { type: "text", text: partialText },
      { type: "notice", level: "error", code: "app_restart", text: "app_restart: touri restarted [TOURI-E1009]" },
    ],
  }
  const marker: Message = {
    ...createMessage({
      id: "m-resume-marker",
      threadId: "thread-mark",
      role: "system",
      text: "Retomado após reinício do touri",
      parentId: partial.id,
    }),
    kind: "notice",
    parts: [{ type: "notice", level: "info", code: "run_resumed", text: "Retomado após reinício do touri" }],
  }
  const resumed = createMessage({
    id: "m-resume-reply",
    threadId: "thread-mark",
    role: "assistant",
    text: "Conferi o que já estava feito: a tabela de conversões está atualizada. Terminei o resumo e publiquei o rascunho.",
    runId: "run-resumed",
    parentId: marker.id,
  })
  const interrupted: Run = {
    ...createRun({ id: "run-interrupted", threadId: "thread-mark", botId: "bot-mark", status: "interrupted" }),
    errorClass: "app_restart",
    errorMessage: "touri restarted",
    requestMessageId: request.id,
    replyMessageId: partial.id,
    startedAt: now() - 15 * 60_000,
    finishedAt: now() - 2 * 60_000,
  }
  const continued: Run = {
    ...createRun({ id: "run-resumed", threadId: "thread-mark", botId: "bot-mark" }),
    trigger: "retry",
    requestMessageId: marker.id,
    replyMessageId: resumed.id,
  }
  return { messages: [request, partial, marker, resumed], runs: [interrupted, continued] }
}

const getInterruptedTaskFixture = (): { messages: Message[]; runs: Run[] } => {
  const fixture = resumedTurnFixture()
  return {
    runs: fixture.runs.slice(0, 1),
    messages: fixture.messages.slice(0, 2).map((message) => {
      if (message.status !== "failed") return message
      return {
        ...message,
        parts: [
          ...message.parts,
          {
            type: "file_change",
            callId: "write-notes",
            paths: ["notas-da-equipe.md"],
            diff: null,
          },
        ],
      }
    }),
  }
}

const importReport: ImportReport = {
  importId: "import-demo",
  origin: "/Users/demo/.legacy-app",
  dryRun: false,
  bots: { created: 3, updated: 0, unchanged: 0, skipped: 0 },
  threads: { created: 15, updated: 0, unchanged: 0, skipped: 0 },
  messages: { created: 447, updated: 0, unchanged: 0, skipped: 0 },
  routines: { created: 4, updated: 0, unchanged: 0, skipped: 0 },
  attachments: { created: 1, updated: 0, unchanged: 0, skipped: 0 },
  codexSessions: { created: 0, updated: 0, unchanged: 0, skipped: 0 },
  memoryFiles: { created: 4, updated: 0, unchanged: 0, skipped: 0 },
  warnings: ["Imported routines are disabled until you enable them here."],
  droppedMessageKinds: { options: 2 },
}

export const createMockApi = ({ scenario }: { scenario?: MockScenario | null } = {}): MockApi => {
  const routineFixture = scenario === "routine-conversation" ? getRoutineConversationFixture() : null
  const interruptedFixture = scenario === "interrupted-tasks" ? getInterruptedTaskFixture() : null
  const project = createProject()
  const projects: Array<Project> = [project]
  // These local collections model server storage; deletion handlers replace them with the retained rows.
  let bots = seed.bots.map((bot, index) => createBot(bot, index, project.id))
  let threads = seed.threads.map((thread) => {
    if (thread.id === routineFixture?.thread.id) return routineFixture.thread
    const saved = createThread(thread)
    if (thread.id !== "thread-mark" || !interruptedFixture) return saved
    return { ...saved, activeLeafId: interruptedFixture.messages.at(-1)?.id ?? saved.activeLeafId }
  })
  let messages = [
    ...seed.messages
      .filter((message) => message.threadId !== routineFixture?.thread.id)
      .map((message) => createMessage(message)),
    ...(routineFixture?.messages ?? []),
    ...(interruptedFixture?.messages ?? []),
  ]
  const mem0Settings = new Map<string, import("@touri/contracts").Mem0Settings>()
  const goals = new Map<string, Goal>()
  const learning = new Map<string, BotLearning>()
  const machines = new Map<string, import("@touri/contracts").MachineState>()
  const networkPolicies = new Map<string, Record<string, unknown>>()
  const initialRuns = [...(routineFixture ? [routineFixture.run] : []), ...(interruptedFixture?.runs ?? [])]
  let runs = new Map<string, Run>(initialRuns.map((run) => [run.id, run]))
  if (scenario === "resumed-turn") {
    const fixture = resumedTurnFixture()
    messages.push(...fixture.messages)
    for (const run of fixture.runs) runs.set(run.id, run)
    const thread = threads.find((candidate) => candidate.id === "thread-mark")
    if (thread) thread.activeLeafId = fixture.messages.at(-1)?.id ?? null
  }
  for (const thread of seed.threads.filter((candidate) => candidate.running)) {
    const run = createRun({ id: `run-${thread.id}`, threadId: thread.id, botId: thread.botId, status: "running" })
    runs.set(run.id, run)
  }
  const processesByProject = new Map<string, Array<ProcessEntry>>([[project.id, createProcesses(project)]])
  let routines = [routineFixture?.routine ?? createRoutine("bot-mark")]
  let routineRuns: Array<RoutineRun> = [
    routineFixture?.routineRun ?? {
      id: "routine-run-demo",
      routineId: "routine-daily",
      scheduledFor: new Date(2026, 9, 12, 10, 0).getTime(),
      status: "succeeded",
      threadId: "thread-mark",
      runId: null,
      triggerSource: "cron",
      summary: "Daily brief complete",
      startedAt: new Date(2026, 9, 12, 10, 0).getTime(),
      finishedAt: new Date(2026, 9, 12, 10, 1).getTime(),
    },
  ]
  const listeners = new Set<(envelope: UiEventEnvelope) => void>()
  const calls: Array<MockCall> = []
  let sequence = 0
  let importStatus: "running" | "succeeded" | "failed" = "succeeded"
  let settings: ApiRoutes["GET /settings"]["res"]["settings"] = {
    maxConcurrentRuns: 3,
    botVmMemoryMb: 1536,
    defaultProvider: "codex",
    cloneRoot: "/Users/demo/touri-projects",
    cliTelemetry: "off",
    checkForUpdates: false,
    keepRunningInTray: true,
    launchAtLogin: false,
    computerUseHotkey: "⌃⌥⌘.",
    browserExecutable: "system-chrome",
    nativeNotifications: true,
    resumeInterruptedTurns: true,
  }

  let notifications: Array<NotificationRecord> = []

  const resolveNotification = ({
    id,
    resolution,
  }: {
    id: number
    resolution: NonNullable<NotificationRecord["resolution"]>
  }): NotificationRecord | null => {
    const index = notifications.findIndex((item) => item.id === id)
    const current = notifications[index]
    if (!current || current.resolvedAt !== null) return current ?? null
    const next: NotificationRecord = { ...current, resolvedAt: now(), resolution }
    notifications[index] = next
    emit({ type: "notification.resolved", notification: next })
    return next
  }

  const notify = (
    input: Pick<NotificationRecord, "kind" | "title" | "body"> & Partial<NotificationRecord>,
  ): NotificationRecord => {
    const bot = bots.find((candidate) => candidate.id === input.botId) ?? bots[0]
    const record: NotificationRecord = {
      id: notifications.length + 1,
      level: "warning",
      botId: bot?.id ?? null,
      botName: bot?.name ?? null,
      botColor: bot ? avatarColorFor(bot) : "#e5322d",
      avatarShape: bot ? avatarShapeFor(bot) : "classic-none",
      avatarSeed: bot?.avatarSeed ?? null,
      threadId: threads.find((thread) => thread.botId === bot?.id)?.id ?? null,
      requestId: null,
      createdAt: now(),
      resolvedAt: null,
      resolution: null,
      ...input,
    }
    notifications.push(record)
    emit({ type: "notification.created", notification: record })
    return record
  }

  const emit = (event: UiEvent): void => {
    sequence += 1
    const envelope = { seq: sequence, at: now(), event }
    listeners.forEach((listener) => {
      listener(envelope)
    })
  }

  const recoveryTasks = new Map<string, RecoveryTask>(
    scenario === "interrupted-tasks"
      ? [
          {
            id: "run:run-interrupted",
            runId: "run-interrupted",
            routineId: null,
            cause: "app_restart",
            occurredAt: now() - 120000,
            effects: [{ description: "notas-da-equipe.md", uncertain: true, acknowledgeKey: null }],
            notification: notify({
              kind: "turn-failed",
              botId: "bot-mark",
              threadId: "thread-mark",
              title: "Tarefas interrompidas",
              body: "A resposta foi interrompida. Algumas ações podem ter sido concluídas.",
              requestId: "recovery:run:run-interrupted",
            }),
          },
          {
            id: "journal:process-demo",
            runId: null,
            routineId: null,
            cause: "app_restart",
            occurredAt: now() - 90000,
            effects: [{ description: "Prévia do projeto", uncertain: true, acknowledgeKey: "process-preview" }],
            notification: notify({
              kind: "turn-failed",
              botId: bots[1]?.id ?? null,
              title: "Tarefas interrompidas",
              body: "A resposta foi interrompida. Algumas ações podem ter sido concluídas.",
              requestId: "recovery:journal:process-demo",
            }),
          },
          {
            id: "routine:routine-demo",
            runId: null,
            routineId: "routine-daily",
            cause: "timeout",
            occurredAt: now() - 60000,
            effects: [],
            notification: notify({
              kind: "routine-failed",
              botId: bots[2]?.id ?? null,
              title: "Routine failed",
              body: "Não foi possível concluir esta ação. Confira os detalhes do erro.",
              requestId: "recovery:routine:routine-demo",
            }),
          },
        ].map((task): [string, RecoveryTask] => [task.id, task as RecoveryTask])
      : [],
  )
  const getRecoveryTasks = () =>
    [...recoveryTasks.values()].map((task) => ({
      ...task,
      notification: notifications.find((item) => item.id === task.notification.id) ?? task.notification,
    }))

  const findThread = (id: string): Thread | undefined => threads.find((thread) => thread.id === id)
  const findRun = (id: string): Run | undefined => runs.get(id)
  const allProcesses = (): Array<ProcessEntry> => [...processesByProject.values()].flat()
  const findProcess = (id: string): ProcessEntry | undefined => allProcesses().find((entry) => entry.spec.id === id)

  const apiModels = new Map<string, ApiModel>()
  let groups: BotGroup[] = []
  const telegram = new Map<string, TelegramIntegration>()
  const request: ApiRequest = async (route, input, pathValues = {}) => {
    const recordedInput =
      String(route).includes("/api-models") && input && typeof input === "object"
        ? Object.fromEntries(
            Object.entries(input).map(([name, value]) => [name, name === "apiKey" ? "[REDACTED]" : value]),
          )
        : input
    calls.push({ route: String(route), input: recordedInput, pathValues })
    const key = String(route)
    if (key === "DELETE /bots/:id") {
      const bot = bots.find((bot) => bot.id === pathValues.id)
      if (!bot || (input as ApiRoutes["DELETE /bots/:id"]["req"]).name !== bot.name)
        throw new Error("Digite o nome do bot para excluir.")
      const ownedThreads = new Set(threads.filter((thread) => thread.botId === bot.id).map((thread) => thread.id))
      messages = messages.filter((message) => !ownedThreads.has(message.threadId))
      threads = threads.filter((thread) => !ownedThreads.has(thread.id))
      runs = new Map([...runs].filter(([, run]) => !ownedThreads.has(run.threadId)))
      notifications = notifications.filter((item) => item.botId !== bot.id && !ownedThreads.has(item.threadId ?? ""))
      routines = routines.filter((routine) => routine.botId !== bot.id)
      bots = bots.filter((candidate) => candidate.id !== bot.id)
      const affectedGroups = groups.filter(
        (group) => group.memberIds.includes(bot.id) || group.coordinatorBotId === bot.id,
      )
      groups = groups.map((group) => ({
        ...group,
        memberIds: group.memberIds.filter((id) => id !== bot.id),
        coordinatorBotId: group.coordinatorBotId === bot.id ? null : group.coordinatorBotId,
      }))
      groups
        .filter((group) => affectedGroups.some((previous) => previous.id === group.id))
        .forEach((group) => {
          emit({ type: "group.updated", group })
        })
      emit({ type: "bot.deleted", botId: bot.id })
      return {} as ApiRoutes[typeof route]["res"]
    }
    if (key === "POST /approvals/:id") {
      const body = input as ApiRoutes["POST /approvals/:id"]["req"]
      for (const message of messages) {
        const part = message.parts.find((part) => part.type === "approval" && part.approvalId === pathValues.id)
        if (part?.type === "approval") {
          part.decision = body.decision
          part.resolvedAt = now()
          part.standing = body.standing === true
          emit({ type: "message.updated", message })
        }
      }
      return {} as ApiRoutes[typeof route]["res"]
    }
    if (key === "GET /bots/:id/grants") return { grants: [] } as ApiRoutes[typeof route]["res"]
    if (key === "GET /bots/:id/mem0" || key === "PUT /bots/:id/mem0") {
      const botId = pathValues.id ?? ""
      const { apiKey, ...patch } = key === "PUT /bots/:id/mem0" ? (input as ApiRoutes["PUT /bots/:id/mem0"]["req"]) : {}
      const current = mem0Settings.get(botId) ?? {
        enabled: false,
        mode: "platform" as const,
        url: "",
        scope: "user" as const,
        autoSync: true,
        topK: 6,
        threshold: 0.3,
        hasApiKey: false,
      }
      const mode = patch.mode ?? current.mode
      const url = (patch.url ?? current.url).replace(/\/+$/, "")
      const hasDestinationChanged = mode !== current.mode || (mode === "server" && url !== current.url)
      const hasApiKey = apiKey === undefined ? current.hasApiKey && !hasDestinationChanged : apiKey !== null
      const next = {
        ...current,
        ...patch,
        url,
        hasApiKey,
      }
      mem0Settings.set(botId, next)
      return { settings: next } as ApiRoutes[typeof route]["res"]
    }
    if (key === "POST /bots/:id/mem0/test") return { ok: true } as ApiRoutes[typeof route]["res"]
    if (key === "GET /bots/:id/mcp") return { servers: [] } as ApiRoutes[typeof route]["res"]
    if (key === "GET /bots/:id/integrations/telegram" || key === "PUT /bots/:id/integrations/telegram") {
      const botId = pathValues.id ?? ""
      const current = telegram.get(botId) ?? {
        config: { enabled: false, allowedUserIds: [], homeChatId: null, forwardRoutines: false },
        tokenSaved: false,
        status: { state: "off" as const, username: null, error: null },
        lastRejected: null,
      }
      if (key === "PUT /bots/:id/integrations/telegram") {
        const { token, ...config } = input as ApiRoutes["PUT /bots/:id/integrations/telegram"]["req"]
        const nextConfig = { ...current.config, ...config }
        const tokenSaved = token === undefined ? current.tokenSaved : token !== null
        const next = {
          ...current,
          config: nextConfig,
          tokenSaved,
          status: getMockTelegramStatus(nextConfig.enabled, tokenSaved),
        }
        telegram.set(botId, next)
        return { telegram: next } as ApiRoutes[typeof route]["res"]
      }
      return { telegram: current } as ApiRoutes[typeof route]["res"]
    }
    if (key === "GET /bots/:id/learning" || key === "PUT /bots/:id/learning") {
      const id = pathValues.id ?? ""
      const current = learning.get(id) ?? {
        memory: false,
        skills: false,
        memoryEveryTurns: 10,
        skillsAfterToolCalls: 10,
        turns: 0,
        toolCalls: 0,
        reviewThreadId: null,
        memoryChars: 0,
        userChars: 0,
        skillCount: 0,
      }
      const next = key === "PUT /bots/:id/learning" ? { ...current, ...(input as Partial<BotLearning>) } : current
      learning.set(id, next)
      return { learning: next } as ApiRoutes[typeof route]["res"]
    }
    if (key === "GET /bots/:id/mcp/prerequisites")
      return {
        prerequisites: { machine: "local", status: "checked", node: true, oauthKeys: true, credentials: true },
      } as ApiRoutes[typeof route]["res"]
    if (key === "POST /bots/:id/mcp/test" || key === "PUT /bots/:id/mcp/:name")
      return {
        server: { ...(input as McpServer), tools: [{ name: "sample_tool", description: "Ferramenta de exemplo" }] },
      } as ApiRoutes[typeof route]["res"]
    if (key === "GET /api-models") return { models: Array.from(apiModels.values()) } as never
    if (key === "POST /api-models") {
      const config = input as ApiRoutes["POST /api-models"]["req"]
      const model: ApiModel = {
        id: crypto.randomUUID(),
        preset: config.preset,
        name: config.name || "API",
        baseUrl: config.baseUrl || "https://api.example.com/v1",
        modelId: config.modelId,
      }
      apiModels.set(model.id, model)
      return { model } as never
    }
    if (key === "DELETE /api-models/:id") {
      apiModels.delete(pathValues.id || "")
      return {} as never
    }
    if (key === "POST /api-models/models") return { models: ["demo-model", "demo-reasoning"] } as never
    if (key === "POST /api-models/test" || key === "POST /api-models/:id/test") return { ok: true } as never
    if (key === "GET /provider-profiles") return { profiles: [] } as ApiRoutes[typeof route]["res"]
    if (key === "GET /providers/opencode/models")
      return {
        models: ["openrouter/deepseek/deepseek-v3.2"],
        defaultModel: "openrouter/deepseek/deepseek-v3.2",
        available: true,
      } as ApiRoutes[typeof route]["res"]
    if ((key as string) === "GET /bots/:id/network-policy" || (key as string) === "PUT /bots/:id/network-policy") {
      const botId = pathValues.id ?? ""
      const current = networkPolicies.get(botId) ?? {
        allowLan: false,
        resolvers: ["1.1.1.1", "8.8.8.8"],
        privateDomains: [],
        restrictPublic: false,
        publicHosts: [],
      }
      const requested = (key as string).startsWith("PUT") ? { ...current, ...(input as object) } : current
      networkPolicies.set(botId, requested)
      return {
        requested,
        active: requested,
        providerHosts:
          bots.find((bot) => bot.id === botId)?.provider === "claude"
            ? ["anthropic.com", "claude.ai", "claude.com"]
            : ["openai.com", "chatgpt.com"],
      } as unknown as ApiRoutes[typeof route]["res"]
    }
    if (key === "GET /bots/:id/provider-login/flow" || key === "POST /bots/:id/provider-login/flow")
      return {
        provider: (input as { provider: string }).provider,
        state: "ready",
        executable: "available",
        host: "server",
      } as ApiRoutes[typeof route]["res"]
    if (key === "GET /bots/:id/provider-login")
      return {
        provider: "claude",
        ready: false,
        source: "missing",
        message: "Login não conectado nesta máquina.",
      } as ApiRoutes[typeof route]["res"]
    if (key === "GET /health")
      return {
        ok: true,
        version: rootPackage.version,
        schemaVersion: 1,
        host: "server",
      } as ApiRoutes[typeof route]["res"]
    if (key === "POST /ui/errors") return { ok: true } as ApiRoutes[typeof route]["res"]
    if (key === "POST /computer/kill") return { revoked: 1 } as ApiRoutes[typeof route]["res"]
    if (key === "GET /bots/:id/files")
      return {
        files: (input as { path?: string }).path
          ? []
          : [
              { name: "notas.md", path: "notas.md", directory: false, bytes: 85 },
              { name: "documentos", path: "documentos", directory: true, bytes: 0 },
            ],
      } as ApiRoutes[typeof route]["res"]
    if (key === "GET /bots/:id/files/content")
      return {
        name: "notas.md",
        mime: "text/markdown",
        base64: btoa("# Workspace do bot\n\nArquivos e notas de trabalho do touri."),
      } as ApiRoutes[typeof route]["res"]
    if (key === "POST /bots/:id/machine/shell")
      return { stdout: "/workspace\n", stderr: "", code: 0 } as ApiRoutes[typeof route]["res"]
    if (key === "POST /bots/:id/machine/intent") {
      const { intent } = input as ApiRoutes["POST /bots/:id/machine/intent"]["req"]
      if (["computer-visible", "computer-hidden", "foreground", "background"].includes(intent))
        return {
          machine: machines.get(pathValues.id ?? "") ?? {
            botId: pathValues.id ?? "",
            status: "stopped",
            progress: null,
            error: null,
            memoryMb: settings.botVmMemoryMb ?? 1536,
            createdMs: null,
            startMs: null,
          },
        } as ApiRoutes[typeof route]["res"]
      const machine = {
        botId: pathValues.id ?? "",
        status: intent === "idle" ? ("stopped" as const) : ("running" as const),
        progress: null,
        error: null,
        memoryMb: settings.botVmMemoryMb ?? 1536,
        createdMs: null,
        startMs: null,
      }
      machines.set(machine.botId, machine)
      emit({ type: "machine.updated", machine })
      return { machine } as ApiRoutes[typeof route]["res"]
    }
    if (key === "GET /machines")
      return {
        capability: { available: true, reason: null, provider: "apple-container" },
        machines: bots
          .filter((bot) => bot.machine === "vm")
          .map(
            (bot) =>
              machines.get(bot.id) ?? {
                botId: bot.id,
                status: "stopped",
                progress: null,
                error: null,
                memoryMb: settings.botVmMemoryMb ?? 1536,
                createdMs: null,
                startMs: null,
              },
          ),
      } as ApiRoutes[typeof route]["res"]
    if (key === "POST /machines/service/start") {
      const { botId } = input as ApiRoutes["POST /machines/service/start"]["req"]
      if (!botId) return { machine: null } as ApiRoutes[typeof route]["res"]
      const machine = {
        botId,
        status: "running" as const,
        progress: null,
        error: null,
        memoryMb: settings.botVmMemoryMb ?? 1536,
        createdMs: null,
        startMs: null,
      }
      emit({ type: "machine.updated", machine })
      return { machine } as ApiRoutes[typeof route]["res"]
    }
    if (key === "POST /bots/:id/machine/stop") {
      const machine = {
        botId: pathValues.id ?? "",
        status: "stopped" as const,
        progress: null,
        error: null,
        memoryMb: settings.botVmMemoryMb ?? 1536,
        createdMs: null,
        startMs: null,
      }
      emit({ type: "machine.updated", machine })
      return { machine } as ApiRoutes[typeof route]["res"]
    }
    if (key === "POST /bots/:id/machine/restart" || key === "POST /bots/:id/machine/reset") {
      const machine = {
        botId: pathValues.id ?? "",
        status: "running" as const,
        progress: null,
        error: null,
        memoryMb: settings.botVmMemoryMb ?? 1536,
        createdMs: 2000,
        startMs: 1500,
      }
      machines.set(machine.botId, machine)
      emit({ type: "machine.updated", machine })
      return { machine } as ApiRoutes[typeof route]["res"]
    }
    if (key === "GET /doctor") return defaultDoctor as ApiRoutes[typeof route]["res"]
    if (key === "GET /doctor/storage")
      return {
        storage: {
          databaseBytes: 0,
          walBytes: 0,
          reusableBytes: 0,
          messageTextBytes: 0,
          messagePartsBytes: 0,
          transcriptBytes: 0,
          eventBytes: 0,
          attachmentBytes: 0,
          turns: 0,
        },
        maintenance: { running: false, processed: 0, total: 0 },
      } as ApiRoutes[typeof route]["res"]
    if (key === "POST /doctor/storage/compact")
      return {
        maintenance: { running: false, processed: 0, total: 0 },
      } as ApiRoutes[typeof route]["res"]
    if (key === "GET /groups") return { groups } as ApiRoutes[typeof route]["res"]
    if (key === "DELETE /groups/:id") {
      const group = groups.find((group) => group.id === pathValues.id)
      if (!group) throw new ApiError(404, "", "NOT_FOUND", "TOURI-E1002")
      const threadIds = new Set(threads.filter((thread) => thread.groupId === group.id).map((thread) => thread.id))
      const isBusy = [...runs.values()].some(
        (run) => threadIds.has(run.threadId) && ["queued", "starting", "running"].includes(run.status),
      )
      if (isBusy) throw new ApiError(409, "", "GROUP_BUSY")

      const routineIds = new Set(
        routines.filter((routine) => routine.groupId === group.id).map((routine) => routine.id),
      )
      groups = groups.filter((candidate) => candidate.id !== group.id)
      routines = routines.filter((routine) => !routineIds.has(routine.id))
      routineRuns = routineRuns.filter((run) => !routineIds.has(run.routineId))
      threads = threads.filter((thread) => !threadIds.has(thread.id))
      messages = messages.filter((message) => !threadIds.has(message.threadId))
      runs = new Map([...runs].filter(([, run]) => !threadIds.has(run.threadId)))
      notifications = notifications.filter((item) => !threadIds.has(item.threadId ?? ""))
      emit({ type: "group.deleted", groupId: group.id })
      return {} as ApiRoutes[typeof route]["res"]
    }
    if (key === "GET /groups/:id/threads")
      return {
        threads: threads.filter((t) => t.groupId === pathValues.id && !t.groupThreadId),
      } as ApiRoutes[typeof route]["res"]
    if (key === "POST /groups" || key === "PATCH /groups/:id") {
      const values = input as GroupInput
      const existing = groups.find((g) => g.id === pathValues.id)
      const group: BotGroup = {
        ...existing,
        ...values,
        id: existing?.id ?? crypto.randomUUID(),
        avatarSeed: existing?.avatarSeed ?? crypto.randomUUID(),
        createdAt: existing?.createdAt ?? now(),
        updatedAt: now(),
      }
      if (existing) Object.assign(existing, group)
      else groups.push(group)
      emit({ type: "group.updated", group })
      if (existing) return { group } as ApiRoutes[typeof route]["res"]
      const thread = {
        ...createThread({
          id: crypto.randomUUID(),
          botId: values.memberIds[0] ?? "",
          title: group.name,
          running: false,
        }),
        groupId: group.id,
        kind: "chat" as const,
      }
      threads.push(thread)
      emit({ type: "thread.updated", thread })
      return { group, thread } as ApiRoutes[typeof route]["res"]
    }
    if (key === "POST /groups/:id/threads") {
      const group = groups.find((g) => g.id === pathValues.id)
      if (!group) throw new Error("Group not found")
      const thread = {
        ...createThread({
          id: crypto.randomUUID(),
          botId: group.memberIds[0] ?? "",
          title: (input as { title: string }).title,
          running: false,
        }),
        groupId: group.id,
        kind: "chat" as const,
      }
      threads.push(thread)
      emit({ type: "thread.updated", thread })
      return { thread } as ApiRoutes[typeof route]["res"]
    }
    if (key === "GET /workspace/activity") {
      const visible = threads.filter((thread) => !thread.groupThreadId && !thread.archivedAt)
      const selected = new Set<Message>()
      for (const thread of visible) {
        const rows = messages.filter((message) => message.threadId === thread.id)
        const latest = [...rows].sort((a, b) => b.createdAt - a.createdAt)
        for (const row of [
          latest.find(
            (message) =>
              message.text.trim() || message.parts.some((part) => part.type === "approval" || part.type === "notice"),
          ),
          latest.find((message) => message.role === "assistant"),
          [...rows].sort((a, b) => b.updatedAt - a.updatedAt).find((message) => message.role === "assistant"),
          [...rows]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .find((message) => message.role === "assistant" && message.status !== "streaming"),
          [...rows]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .find((message) => message.role === "assistant" && message.status === "complete"),
          ...rows.filter((message) => message.parts.some((part) => part.type === "approval")),
        ])
          if (row) selected.add(row)
      }
      const latestRuns = visible.flatMap((thread) => {
        const rows = [...runs.values()]
          .filter((run) => run.threadId === thread.id)
          .sort((a, b) => b.queuedAt - a.queuedAt)
        return rows.filter((run, index) => index === 0 || ["queued", "starting", "running"].includes(run.status))
      })
      return {
        messages: [...selected].map((message) => ({
          ...structuredClone(message),
          text: message.text.slice(0, 512),
          parts: message.parts.filter((part) => part.type === "approval" || part.type === "notice"),
        })),
        runs: latestRuns,
      } as ApiRoutes[typeof route]["res"]
    }
    if (key === "GET /search") {
      const query = input as ApiRoutes["GET /search"]["req"]
      const tokens = query.q.toLocaleLowerCase().trim().split(/\s+/u)
      return {
        hits: messages
          .filter((message) => {
            const thread = threads.find((thread) => thread.id === message.threadId)
            return (
              thread &&
              !thread.groupThreadId &&
              (!query.botId || thread.botId === query.botId) &&
              tokens.every((token) => message.text.toLocaleLowerCase().includes(token))
            )
          })
          .slice(-50)
          .reverse()
          .map((message) => ({
            threadId: message.threadId,
            messageId: message.id,
            snippet: message.text.slice(0, 512),
          })),
      } as ApiRoutes[typeof route]["res"]
    }
    if (key === "GET /bots") return { bots } as ApiRoutes[typeof route]["res"]
    if (key === "POST /bots") {
      const botInput = input as ApiRoutes["POST /bots"]["req"]
      const bot = createBot(
        { id: `bot-${bots.length + 1}`, name: botInput.name, provider: botInput.provider, paused: false, unread: 0 },
        bots.length,
        botInput.projectId ?? null,
      )
      const storedBot: Bot = Object.assign(bot, botInput, { updatedAt: now() })
      bots.push(storedBot)
      const thread = createThread({
        id: `thread-${bot.id}`,
        botId: bot.id,
        title: "First conversation",
        running: false,
      })
      threads.push(thread)
      const updatedBot: Bot = { ...storedBot, mainThreadId: thread.id }
      bots[bots.length - 1] = updatedBot
      emit({ type: "bot.updated", bot: updatedBot })
      emit({ type: "thread.updated", thread })
      return { bot: updatedBot } as ApiRoutes[typeof route]["res"]
    }
    if (key === "PATCH /bots/:id") {
      const bot = bots.find((candidate) => candidate.id === pathValues.id)
      if (!bot) throw new Error("bot not found")
      Object.assign(bot, input as Partial<Bot>, { updatedAt: now() })
      emit({ type: "bot.updated", bot })
      return { bot } as ApiRoutes[typeof route]["res"]
    }
    if (key === "GET /bots/:id/threads")
      return {
        threads: threads.filter((thread) => thread.botId === pathValues.id && !thread.groupId),
      } as ApiRoutes[typeof route]["res"]
    if (key === "POST /threads") {
      const threadInput = input as ApiRoutes["POST /threads"]["req"]
      const thread = createThread({
        id: `thread-${threads.length + 1}`,
        botId: threadInput.botId,
        title: threadInput.title ?? "New conversation",
        running: false,
      })
      threads.push(thread)
      emit({ type: "thread.updated", thread })
      return { thread } as ApiRoutes[typeof route]["res"]
    }
    if (key === "PATCH /threads/:id") {
      const thread = findThread(pathValues.id ?? "")
      if (!thread) throw new Error("thread not found")
      Object.assign(thread, input as Partial<Thread>, { updatedAt: now() })
      emit({ type: "thread.updated", thread })
      return { thread } as ApiRoutes[typeof route]["res"]
    }
    if (key === "GET /threads/:id/messages") {
      const threadMessages = messages.filter((message) => message.threadId === pathValues.id)
      return {
        messages: threadMessages,
        activeLeafId: findThread(pathValues.id ?? "")?.activeLeafId ?? null,
      } as ApiRoutes[typeof route]["res"]
    }
    if (key === "GET /runs")
      return {
        runs: [...runs.values()].filter((run) => ["queued", "starting", "running"].includes(run.status)),
      } as ApiRoutes[typeof route]["res"]
    if (key === "GET /threads/:id/goal")
      return { goal: goals.get(pathValues.id ?? "") ?? null } as ApiRoutes[typeof route]["res"]
    if (key === "POST /threads/:id/goal") {
      const values = input as ApiRoutes["POST /threads/:id/goal"]["req"]
      const thread = findThread(pathValues.id ?? "")
      const request = messages.find((message) => message.id === values.requestMessageId)
      if (!thread || !request) throw new Error("NOT_FOUND")
      const goal: Goal = {
        id: `goal-${now()}`,
        threadId: thread.id,
        botId: thread.botId,
        requestMessageId: request.id,
        text: request.text,
        completionCriterion: values.completionCriterion,
        status: "active",
        maxTurns: values.maxTurns,
        turnsUsed: 1,
        deadlineAt: now() + values.maxMinutes * 60_000,
        runId: null,
        steps: [],
        createdAt: now(),
        updatedAt: now(),
      }
      goals.set(thread.id, goal)
      return { goal } as ApiRoutes[typeof route]["res"]
    }
    if (key === "PATCH /threads/:id/goal") {
      const values = input as ApiRoutes["PATCH /threads/:id/goal"]["req"]
      const goal = goals.get(pathValues.id ?? "")
      if (!goal) throw new Error("NOT_FOUND")
      const statuses = { pause: "paused", resume: "active", complete: "completed", budget: goal.status } as const
      const next: Goal = {
        ...goal,
        status: statuses[values.action],
        maxTurns: values.maxTurns ?? goal.maxTurns,
        deadlineAt: values.maxMinutes ? now() + values.maxMinutes * 60_000 : goal.deadlineAt,
        updatedAt: now(),
      }
      goals.set(goal.threadId, next)
      return { goal: next } as ApiRoutes[typeof route]["res"]
    }
    if (key === "GET /threads/:id/runs")
      return {
        runs: [...runs.values()].filter((run) => run.threadId === pathValues.id),
      } as ApiRoutes[typeof route]["res"]
    // r8 composer: mirror the existing native attachment registration contract.
    if (key === "POST /attachments") {
      const request = input as ApiRoutes["POST /attachments"]["req"]
      const path = "grantId" in request ? `/mock/${request.grantId}` : request.path
      return {
        attachment: { id: `attachment:${path}`, path, mime: "application/octet-stream", bytes: 0 },
      } as ApiRoutes[typeof route]["res"]
    }
    if (key === "POST /threads/:id/messages") {
      const messageInput = input as ApiRoutes["POST /threads/:id/messages"]["req"]
      const bot = bots.find(
        (candidate) =>
          candidate.mainThreadId === pathValues.id ||
          threads.some((thread) => thread.id === pathValues.id && thread.botId === candidate.id),
      )
      const botId = bot?.id ?? "bot-mark"
      const userMessage = createMessage({
        id: `message-${messages.length + 1}`,
        threadId: pathValues.id ?? "",
        role: "user",
        text: messageInput.text,
        parentId: messageInput.parentId,
      })
      const run = createRun({ id: `run-${runs.size + 1}`, threadId: pathValues.id ?? "", botId, status: "queued" })
      const reply = createMessage({
        id: `message-${messages.length + 2}`,
        threadId: pathValues.id ?? "",
        role: "assistant",
        text: "",
        status: "streaming",
        runId: run.id,
        parentId: userMessage.id,
      })
      run.requestMessageId = userMessage.id
      run.replyMessageId = reply.id
      messages.push(userMessage, reply)
      runs.set(run.id, run)
      emit({ type: "message.created", message: userMessage })
      emit({ type: "message.created", message: reply })
      emit({ type: "run.updated", run })
      const deltas = [
        "Coloquei sua solicitação na fila local. ",
        "Vou manter o contexto da conversa, ",
        "e o próximo passo está pronto.",
      ]
      deltas.forEach((delta, index) => {
        setTimeout(() => {
          const current = messages.find((message) => message.id === reply.id)
          const currentRun = findRun(run.id)
          if (!current || !currentRun) return
          current.text += delta
          current.parts = [{ type: "text", text: current.text }]
          emit({ type: "message.delta", threadId: current.threadId, messageId: current.id, partIndex: 0, delta })
          if (index === deltas.length - 1) {
            current.status = "complete"
            currentRun.status = "succeeded"
            currentRun.finishedAt = now()
            emit({ type: "message.updated", message: current })
            emit({ type: "run.updated", run: currentRun })
          }
        }, index * 25)
      })
      return { message: userMessage, run } as ApiRoutes[typeof route]["res"]
    }
    if (key === "POST /runs/:id/cancel") {
      const run = findRun(pathValues.id ?? "")
      if (!run) throw new Error("run not found")
      run.status = "canceled"
      run.errorClass = "canceled"
      run.finishedAt = now()
      emit({ type: "run.updated", run })
      return { run } as ApiRoutes[typeof route]["res"]
    }
    if (key === "POST /runs/:id/retry") {
      const run =
        findRun(pathValues.id ?? "") ??
        createRun({
          id: pathValues.id ?? "run-failed",
          threadId: "thread-mark",
          botId: "bot-mark",
          status: "failed",
          errorClass: "cli_crash",
        })
      const retry = createRun({
        id: `run-${runs.size + 1}`,
        threadId: run.threadId,
        botId: run.botId,
        status: "queued",
      })
      retry.trigger = "retry"
      runs.set(retry.id, retry)
      emit({ type: "run.updated", run: retry })
      return { run: retry } as ApiRoutes[typeof route]["res"]
    }
    if (key === "GET /routines")
      return {
        host: "mac",
        routines: routines.filter(
          (routine) =>
            !input || !(input as { botId?: string }).botId || routine.botId === (input as { botId?: string }).botId,
        ),
      } as ApiRoutes[typeof route]["res"]
    if (key === "GET /routine-runs") {
      const query = input as { botId?: string; from?: number; to?: number }
      const routineIds = new Set(
        routines.filter((routine) => !query.botId || routine.botId === query.botId).map((routine) => routine.id),
      )
      return {
        routineRuns: routineRuns.filter(
          (routineRun) =>
            routineIds.has(routineRun.routineId) &&
            (query.from === undefined || routineRun.scheduledFor >= query.from) &&
            (query.to === undefined || routineRun.scheduledFor <= query.to),
        ),
      } as ApiRoutes[typeof route]["res"]
    }
    if (key === "POST /routines") {
      const routineInput = input as ApiRoutes["POST /routines"]["req"]
      const routine: Routine = {
        ...createRoutine(routineInput.botId),
        ...routineInput,
        id: `routine-${crypto.randomUUID()}`,
      }
      routines.push(routine)
      emit({ type: "routine.updated", routine, lastRun: null })
      return { routine } as ApiRoutes[typeof route]["res"]
    }
    if (key === "PATCH /routines/:id") {
      const routine = routines.find((candidate) => candidate.id === pathValues.id)
      if (!routine) throw new Error("routine not found")
      Object.assign(routine, input as Partial<Routine>, { updatedAt: now() })
      emit({ type: "routine.updated", routine, lastRun: null })
      return { routine } as ApiRoutes[typeof route]["res"]
    }
    if (key === "DELETE /routines/:id") {
      const index = routines.findIndex((routine) => routine.id === pathValues.id)
      if (index < 0) throw new Error("routine not found")
      routines.splice(index, 1)
      emit({ type: "routine.deleted", routineId: pathValues.id ?? "" })
      return {} as ApiRoutes[typeof route]["res"]
    }
    if (key === "POST /routines/:id/run") {
      const routine = routines.find((candidate) => candidate.id === pathValues.id)
      if (!routine) throw new Error("routine not found")
      const routineRun: RoutineRun = {
        id: `routine-run-${now()}`,
        routineId: pathValues.id ?? "",
        scheduledFor: now(),
        status: "running",
        threadId: null,
        runId: null,
        triggerSource: "manual",
        summary: null,
        startedAt: now(),
        finishedAt: null,
      }
      routineRuns.push(routineRun)
      emit({ type: "routine.updated", routine, lastRun: routineRun })
      return { routineRun } as ApiRoutes[typeof route]["res"]
    }
    if (key === "GET /mcp/tools")
      return {
        server: { name: "touri", version: rootPackage.version },
        tools: toolCatalog.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          group: tool["x-touri"].group,
        })),
      } as ApiRoutes[typeof route]["res"]
    if (key === "GET /folders") {
      const path = (input as ApiRoutes["GET /folders"]["req"]).path ?? "/workspace"
      return {
        canGrant: true,
        home: "/workspace",
        path,
        parent: path === "/" ? null : path.slice(0, path.lastIndexOf("/")) || "/",
        folders: [],
        truncated: false,
      } as ApiRoutes[typeof route]["res"]
    }
    if (key === "POST /folders") {
      const folder = input as ApiRoutes["POST /folders"]["req"]
      return { path: `${folder.path}/${folder.name}` } as ApiRoutes[typeof route]["res"]
    }
    if (key === "GET /projects") return { projects } as ApiRoutes[typeof route]["res"]
    if (key === "GET /projects/discover") return { repositories: [] } as ApiRoutes[typeof route]["res"]
    if (key === "POST /projects") {
      const projectInput = input as ApiRoutes["POST /projects"]["req"]
      const requestedName = projectInput.name?.trim()
      const fallbackName =
        "gitUrl" in projectInput
          ? projectInput.gitUrl
              .split("/")
              .at(-1)
              ?.replace(/\.git$/i, "") || "project"
          : projectInput.path.split("/").filter(Boolean).at(-1) || "project"
      const nextProject: Project = {
        id: `project-${projects.length + 1}`,
        name: requestedName || fallbackName,
        path: "path" in projectInput ? projectInput.path : `${projectInput.parentDir}/${requestedName || fallbackName}`,
        gitRemote: "gitUrl" in projectInput ? projectInput.gitUrl : null,
        defaultBranch: "main",
        dataDir: `/Users/demo/Library/Application Support/touri/projects/project-${projects.length + 1}`,
        createdAt: now(),
        updatedAt: now(),
        archivedAt: null,
      }
      projects.push(nextProject)
      processesByProject.set(nextProject.id, [])
      return { project: nextProject } as ApiRoutes[typeof route]["res"]
    }
    if (key === "GET /projects/:id/git")
      return { branch: "main", dirty: true, ahead: 1, behind: 0 } as ApiRoutes[typeof route]["res"]
    if (key === "GET /projects/:id/secrets") return { secrets: [] } as ApiRoutes[typeof route]["res"]
    if (key === "PUT /projects/:id/secrets/:name") throw new Error("Secret metadata is available after native save.")
    if (key === "DELETE /projects/:id/secrets/:name") return {} as ApiRoutes[typeof route]["res"]
    if (key === "GET /projects/:id/processes")
      return { processes: processesByProject.get(pathValues.id ?? "") ?? [] } as ApiRoutes[typeof route]["res"]
    if (key === "PUT /projects/:id/processes/:name") {
      const targetProject = projects.find((candidate) => candidate.id === pathValues.id)
      if (!targetProject) throw new Error("project not found")
      const targetProcesses = processesByProject.get(targetProject.id) ?? []
      const processInput = input as ApiRoutes["PUT /projects/:id/processes/:name"]["req"]
      const existing = targetProcesses.find((entry) => entry.spec.name === pathValues.name)
      const spec: ProcessSpec = {
        id: existing?.spec.id ?? `process-${targetProject.id}-${targetProcesses.length + 1}`,
        projectId: targetProject.id,
        name: pathValues.name ?? "process",
        command: processInput.command,
        cwd: processInput.cwd,
        env: processInput.env,
        autostart: processInput.autostart,
        restart: processInput.restart,
        dependsOn: processInput.dependsOn,
        ready: processInput.ready,
        // The mock simulates an HTTP port when auto-detection is selected.
        previewPort: processInput.previewPort ?? 4310,
        createdBy: processInput.createdBy,
        createdAt: existing?.spec.createdAt ?? now(),
        updatedAt: now(),
      }
      const entry: ProcessEntry = { spec, run: existing?.run ?? null }
      processesByProject.set(targetProject.id, [
        ...targetProcesses.filter((candidate) => candidate.spec.id !== spec.id),
        entry,
      ])
      return { spec } as ApiRoutes[typeof route]["res"]
    }
    if (key === "GET /processes/:id/logs")
      return {
        lines: ["[mock] process is ready", "[mock] listening on http://localhost:4310"],
      } as ApiRoutes[typeof route]["res"]
    if (key === "POST /processes/:id/start" || key === "POST /processes/:id/restart") {
      const entry = findProcess(pathValues.id ?? "")
      if (!entry) throw new Error("process not found")
      entry.run = {
        id: `process-run-${now()}`,
        processId: entry.spec.id,
        pid: 1001,
        pgid: 1001,
        status: "ready",
        exitCode: null,
        signal: null,
        ports: entry.spec.previewPort
          ? [{ port: entry.spec.previewPort, host: "127.0.0.1", pid: 1001, detectedAt: now(), via: "log" }]
          : [],
        logPath: "/mock/process.log",
        startedAt: now(),
        endedAt: null,
      }
      emit({ type: "process.updated", spec: entry.spec, run: entry.run })
      if (entry.spec.previewPort)
        emit({
          type: "preview.available",
          preview: {
            projectId: entry.spec.projectId,
            processId: entry.spec.id,
            url: `http://localhost:${entry.spec.previewPort}`,
            port: entry.spec.previewPort,
            label: entry.spec.name,
          },
        })
      return { run: entry.run } as ApiRoutes[typeof route]["res"]
    }
    if (key === "POST /processes/:id/stop") {
      const entry = findProcess(pathValues.id ?? "")
      if (!entry?.run) throw new Error("process not running")
      entry.run = { ...entry.run, status: "stopped", endedAt: now() }
      emit({ type: "process.updated", spec: entry.spec, run: entry.run })
      return { run: entry.run } as ApiRoutes[typeof route]["res"]
    }
    if (key === "GET /previews") {
      const running = allProcesses().find((entry) => entry.run?.status === "ready" && entry.spec.previewPort)
      return {
        previews: running?.spec.previewPort
          ? [
              {
                projectId: running.spec.projectId,
                processId: running.spec.id,
                url: `http://localhost:${running.spec.previewPort}`,
                port: running.spec.previewPort,
                label: running.spec.name,
              },
            ]
          : [],
      } as ApiRoutes[typeof route]["res"]
    }
    if (key === "GET /browser/tabs") return { tabs: [createBrowserTab()] } as ApiRoutes[typeof route]["res"]
    if (key === "POST /browser/tabs/:id/takeover") return {} as ApiRoutes[typeof route]["res"]
    if (key === "POST /browser/secret-entry/:id") return {} as ApiRoutes[typeof route]["res"]
    if (key === "POST /imports/legacy") {
      importStatus = "running"
      setTimeout(() => {
        importStatus = "succeeded"
        emit({ type: "import.progress", importId: "import-demo", phase: "complete", done: 1, total: 1 })
      }, 30)
      return { importId: "import-demo" } as ApiRoutes[typeof route]["res"]
    }
    if (key === "GET /imports/:id")
      return {
        status: importStatus,
        report: importStatus === "succeeded" ? importReport : null,
      } as ApiRoutes[typeof route]["res"]
    if (key === "GET /recovery") return { tasks: getRecoveryTasks() } as ApiRoutes[typeof route]["res"]
    if (key === "POST /recovery/:id/dismiss") {
      const task = recoveryTasks.get(pathValues.id ?? "")
      if (!task) throw new Error("Tarefa interrompida não encontrada.")
      const { acknowledgeKeys } = input as ApiRoutes["POST /recovery/:id/dismiss"]["req"]
      const keys = task.effects.flatMap((effect) => (effect.acknowledgeKey ? [effect.acknowledgeKey] : []))
      if (keys.some((key) => !acknowledgeKeys.includes(key))) throw new Error("ACKNOWLEDGEMENT_REQUIRED")
      recoveryTasks.set(task.id, {
        ...task,
        effects: task.effects.map((effect) => ({ ...effect, acknowledgeKey: null })),
      })
      resolveNotification({ id: task.notification.id, resolution: "dismissed" })
      return { tasks: getRecoveryTasks() } as ApiRoutes[typeof route]["res"]
    }
    if (key === "GET /notifications")
      return { notifications: [...notifications].reverse() } as ApiRoutes[typeof route]["res"]
    if (key === "GET /notifications/pending")
      return {
        notifications: notifications.filter((item) => item.resolvedAt === null),
        lastSeq: notifications.length,
      } as ApiRoutes[typeof route]["res"]
    if (key === "POST /notifications/:id/dismiss") {
      const hasProtectedTask = getRecoveryTasks().some(
        (task) =>
          task.notification.id === Number(pathValues.id) &&
          task.effects.some((effect) => effect.acknowledgeKey !== null),
      )
      if (hasProtectedTask) throw new Error("Revise os efeitos incertos no centro de tarefas interrompidas.")
      const resolved = resolveNotification({ id: Number(pathValues.id), resolution: "dismissed" })
      if (!resolved) throw new Error("notification not found")
      return { notification: resolved } as ApiRoutes[typeof route]["res"]
    }
    if (key === "POST /notifications/dismiss-all") {
      const protectedIds = new Set(
        getRecoveryTasks()
          .filter((task) => task.effects.some((effect) => effect.acknowledgeKey !== null))
          .map((task) => task.notification.id),
      )
      const open = notifications.filter((item) => item.resolvedAt === null)
      const dismissible = open.filter((item) => !protectedIds.has(item.id))
      dismissible.forEach((item) => {
        resolveNotification({ id: item.id, resolution: "dismissed" })
      })
      return {
        dismissed: dismissible.length,
        skipped: open.length - dismissible.length,
        skippedIds: open.filter((item) => protectedIds.has(item.id)).map((item) => item.id),
      } as ApiRoutes[typeof route]["res"]
    }
    if (key === "POST /threads/:id/respond") {
      const body = input as ApiRoutes["POST /threads/:id/respond"]["req"]
      const target = notifications.find((item) => item.requestId === body.requestId)
      if (!target) throw new Error("request not found")
      resolveNotification({ id: target.id, resolution: body.behavior })
      return {} as ApiRoutes[typeof route]["res"]
    }
    if (key === "POST /bots/:id/messages") {
      const body = input as ApiRoutes["POST /bots/:id/messages"]["req"]
      const threadId = body.threadId ?? threads.find((thread) => thread.botId === pathValues.id)?.id ?? ""
      return request(
        "POST /threads/:id/messages",
        { threadId, parentId: null, text: body.text, attachmentIds: [] },
        { id: threadId },
      )
    }
    if (key === "GET /settings") return { settings } as ApiRoutes[typeof route]["res"]
    if (key === "PATCH /settings") {
      settings = { ...settings, ...(input as Partial<typeof settings>) }
      return { settings } as ApiRoutes[typeof route]["res"]
    }
    throw new Error(`Mock route not implemented: ${key}`)
  }

  return {
    request,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    isMock: true,
    calls,
    emit,
    notify,
    getState: () => ({ bots, threads, messages }),
  }
}

// Mirrors the sidecar restart: enabled without a token is an error, not "off".
function getMockTelegramStatus(enabled: boolean, tokenSaved: boolean): TelegramIntegration["status"] {
  if (!enabled) return { state: "off", username: null, error: null }
  if (!tokenSaved) return { state: "error", username: null, error: "Salve o token do bot do Telegram." }

  return { state: "connected", username: "touri_mock_bot", error: null }
}
