import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { Routine } from "@touri/contracts"
import { describe, expect, it, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import CronScreen from "../src/components/CronScreen"
import { nextRoutineDates, RoutineEditor } from "../src/components/RoutineEditor"
import { getJobTemplates } from "../src/features/jobs/catalog"
import { t } from "../src/i18n"
import { newRoutineDraft, type RoutineDraft, repeatTaskDraft, suggestedRoutineDraft } from "../src/routineDraft"
import { simpleCron, simpleSchedule } from "../src/routineSchedule"
import type { WorkspaceActions } from "../src/useWorkspace"

const required = <T,>(value: T | null | undefined): T => {
  if (value == null) throw new Error("Missing fixture")
  return value
}

const fixture = () => {
  const api = createMockApi()
  const state = api.getState()
  const bot = {
    ...required(state.bots[0]),
    cwd: "/workspace/notes",
    folders: [{ path: "/workspace/data", access: "read-only" as const }],
    mcpServers: [{ name: "Notas", transport: "http" as const, url: "https://notes.example.test", tools: [] }],
  }
  const draft = { ...newRoutineDraft(bot.id), name: "Organizar notas", prompt: "Organize minhas notas em uma lista." }
  const created = {
    ...draft,
    id: "saved-routine",
    nextRunAt: null,
    source: "local",
    createdAt: 0,
    updatedAt: 0,
  } as Routine
  const actions = {
    createRoutine: vi.fn(async (_input: RoutineDraft) => created),
    updateRoutine: vi.fn(async (_id: string, _patch: Partial<RoutineDraft>) => created),
    runRoutine: vi.fn(async () => {}),
    deleteRoutine: vi.fn(async () => {}),
  }
  return { api, state, bot, draft, created, actions }
}

describe("repeating work", () => {
  it("keeps new routine drafts connected to the bot's conversation setting", () => {
    const f = fixture()

    expect(newRoutineDraft(f.bot.id).continuity).toBe("new-thread")
  })

  for (const [mode, destination] of [
    ["main", "Segue o bot: conversa principal"],
    ["task", "Segue o bot: uma conversa nova por tarefa"],
  ] as const) {
    it(`shows the effective ${mode} bot destination for a deferred routine`, () => {
      const f = fixture()
      const bot = { ...f.bot, automaticConversationMode: mode }
      render(<RoutineEditor initial={f.draft} bots={[bot]} actions={f.actions} host="server" onClose={vi.fn()} />)

      const destinationOption = screen.getByRole("combobox", { name: "Destino dos resultados" })
      expect(destinationOption).toHaveValue("new-thread")
      expect(within(destinationOption).getByRole("option", { name: "Seguir configuração do bot" })).toBeInTheDocument()
      fireEvent.click(screen.getByRole("button", { name: "Revisar rotina" }))

      expect(screen.getByText(destination)).toBeVisible()
    })
  }

  it("shows readable Portuguese labels for every routine timezone option", () => {
    const f = fixture()
    const draft = { ...f.draft, timezone: "America/Manaus" }
    render(<RoutineEditor initial={draft} bots={[f.bot]} actions={f.actions} host="server" onClose={vi.fn()} />)

    const timezone = screen.getByRole("combobox", { name: "Fuso horário" })
    const labels = within(timezone)
      .getAllByRole("option")
      .map((option) => option.textContent)

    expect(timezone).toHaveValue("America/Manaus")
    expect(labels).toEqual([
      "Horário de Brasília",
      "Horário do Amazonas",
      "Horário do Acre",
      "Horário de Fernando de Noronha",
      "UTC",
    ])
    expect(labels.some((label) => label?.includes("America/"))).toBe(false)
    expect(t("Horário do Amazonas", {}, "en")).toBe("Amazonas time")
    expect(t("Horário de Fernando de Noronha", {}, "en")).toBe("Fernando de Noronha time")

    fireEvent.click(screen.getByRole("button", { name: "Revisar rotina" }))
    expect(
      within(screen.getByRole("region", { name: "Próximas três execuções" })).getByText("Horário do Amazonas"),
    ).toBeVisible()
  })

  it("localizes a saved timezone outside the Brazil preset list", () => {
    const f = fixture()
    const draft = { ...f.draft, timezone: "America/New_York" }
    render(<RoutineEditor initial={draft} bots={[f.bot]} actions={f.actions} host="server" onClose={vi.fn()} />)

    const timezone = screen.getByRole("combobox", { name: "Fuso horário" })
    const savedZone = timezone.querySelector('option[value="America/New_York"]')

    expect(savedZone).not.toBeNull()
    expect(savedZone?.textContent).not.toBe("America/New_York")
    expect(savedZone?.textContent).not.toContain("America/")
  })

  it("opens a filled draft from a useful result in one click without creating or activating", async () => {
    const f = fixture()
    render(<App kernel={{ services: { api: f.api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" }, { timeout: 15000 })
    fireEvent.click(await screen.findByRole("button", { name: "Agendar esta tarefa" }, { timeout: 15000 }))
    const dialog = screen.getByRole("dialog", { name: "Quando?" })
    expect(within(dialog).getByRole("textbox", { name: "Tarefa" })).toHaveValue("Review the campaign")
    expect(within(dialog).getByRole("combobox", { name: "Bot" })).toHaveValue("bot-mark")
    expect(within(dialog).getByRole("combobox", { name: "Destino dos resultados" })).toHaveValue("results-thread")
    expect(within(dialog).getByText("Histórico desta conversa e permissões atuais do bot.")).toBeVisible()
    expect(f.api.calls.filter((call) => ["POST /routines", "PATCH /routines/:id"].includes(call.route))).toEqual([])
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }))
    expect(screen.queryByRole("dialog")).toBeNull()
  }, 30000)

  it("requires final review and an explicit activation click after choosing days and time", async () => {
    const f = fixture()
    const close = vi.fn()
    render(<RoutineEditor initial={f.draft} bots={[f.bot]} actions={f.actions} host="server" onClose={close} />)
    expect(screen.getByLabelText("Expressão cron")).not.toBeVisible()
    fireEvent.change(screen.getByLabelText("Frequência"), { target: { value: "days" } })
    fireEvent.click(screen.getByLabelText("terça-feira"))
    fireEvent.change(screen.getByLabelText("Às"), { target: { value: "10:30" } })
    fireEvent.keyDown(screen.getByLabelText("Tarefa"), { key: "Enter" })
    expect(f.actions.createRoutine).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Revisar rotina" }))
    expect(screen.getByText("/workspace/notes")).toBeVisible()
    expect(screen.getByText("/workspace/data")).toBeVisible()
    expect(screen.getByText("Fontes: Notas")).toBeVisible()
    expect(
      within(screen.getByRole("region", { name: "Próximas três execuções" })).getAllByRole("listitem"),
    ).toHaveLength(3)
    expect(screen.getByText(/Você pode fechar esta página/)).toBeVisible()
    fireEvent.keyDown(screen.getByRole("button", { name: "Ativar rotina" }), { key: "Enter" })
    fireEvent.keyDown(screen.getByRole("button", { name: "Ativar rotina" }), { key: " " })
    fireEvent.submit(required(screen.getByRole("button", { name: "Ativar rotina" }).closest("form")))
    expect(f.actions.createRoutine).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Ativar rotina" }))
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(f.actions.createRoutine).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, cron: "30 10 * * 1,3,4,5", prompt: f.draft.prompt }),
    )
  })

  it("keeps failed saves and their full draft open and allows retry", async () => {
    const f = fixture()
    const close = vi.fn()
    f.actions.createRoutine.mockRejectedValueOnce(new Error("private technical detail"))
    render(<RoutineEditor initial={f.draft} bots={[f.bot]} actions={f.actions} host="mac" onClose={close} />)
    fireEvent.click(screen.getByRole("button", { name: "Revisar rotina" }))
    fireEvent.click(screen.getByRole("button", { name: "Ativar rotina" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Seu rascunho continua aqui")
    expect(screen.queryByText("private technical detail")).toBeNull()
    expect(close).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Editar" }))
    expect(screen.getByLabelText("Tarefa")).toHaveValue(f.draft.prompt)
    fireEvent.click(screen.getByRole("button", { name: "Revisar rotina" }))
    fireEvent.click(screen.getByRole("button", { name: "Ativar rotina" }))
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
  })

  it("tests a paused draft and then activates the same routine without a duplicate", async () => {
    const f = fixture()
    render(
      <RoutineEditor
        initial={{ ...f.draft, continuity: "results-thread" }}
        bots={[f.bot]}
        actions={f.actions}
        host="mac"
        onClose={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Revisar rotina" }))
    fireEvent.click(screen.getByRole("button", { name: "Testar agora" }))
    await screen.findByRole("status")
    expect(f.actions.createRoutine).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }))
    expect(f.actions.runRoutine).toHaveBeenCalledWith("saved-routine")
    fireEvent.click(screen.getByRole("button", { name: "Ativar rotina" }))
    await waitFor(() =>
      expect(f.actions.updateRoutine).toHaveBeenCalledWith("saved-routine", expect.objectContaining({ enabled: true })),
    )
    expect(f.actions.createRoutine).toHaveBeenCalledOnce()
    expect(f.actions.updateRoutine.mock.calls[0]?.[1]).not.toHaveProperty("resultsThreadId")
  })

  it("invalidates review when task or authorized scope changes", () => {
    const f = fixture()
    const props = { initial: f.draft, bots: [f.bot], actions: f.actions, host: "mac" as const, onClose: vi.fn() }
    const view = render(<RoutineEditor {...props} />)
    fireEvent.click(screen.getByRole("button", { name: "Revisar rotina" }))
    fireEvent.click(screen.getByRole("button", { name: "Editar" }))
    fireEvent.change(screen.getByLabelText("Tarefa"), { target: { value: "Outra tarefa" } })
    expect(screen.queryByRole("button", { name: "Ativar rotina" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Revisar rotina" }))
    view.rerender(<RoutineEditor {...props} bots={[{ ...f.bot, folders: [] }]} />)
    expect(screen.queryByRole("button", { name: "Ativar rotina" })).toBeNull()
    expect(screen.getByRole("button", { name: "Revisar rotina" })).toBeVisible()
  })

  it("shows missed and recovered slots in the history", () => {
    const f = fixture()
    render(
      <CronScreen
        bots={[f.bot]}
        selectedBotId={f.bot.id}
        routines={[f.created]}
        messages={[]}
        actions={f.actions as unknown as WorkspaceActions}
        onNotice={vi.fn()}
        onReviewApprovals={vi.fn()}
        routineRuns={[
          {
            id: "missed",
            routineId: f.created.id,
            scheduledFor: Date.now(),
            status: "skipped",
            triggerSource: "catch-up",
            threadId: null,
            runId: null,
            summary: "",
            startedAt: null,
            finishedAt: null,
          },
        ]}
      />,
    )
    fireEvent.click(screen.getByText("Histórico de execuções"))
    expect(screen.getByText(/Disparo não executado/)).toBeVisible()
    expect(screen.getByText("Execução de recuperação")).toBeVisible()
    expect(screen.queryByText(/skipped|catch-up/)).toBeNull()
  })
})

it("previews three weekday dates in the chosen timezone and handles Sunday and daylight-saving transitions", () => {
  expect(nextRoutineDates("0 9 * * 1-5", "America/Sao_Paulo", Date.parse("2026-10-16T13:00:00Z"))).toEqual([
    Date.parse("2026-10-19T12:00:00Z"),
    Date.parse("2026-10-20T12:00:00Z"),
    Date.parse("2026-10-21T12:00:00Z"),
  ])
  expect(nextRoutineDates("0 9 * * 0", "UTC", Date.parse("2026-10-17T13:00:00Z"))[0]).toBe(
    Date.parse("2026-10-18T09:00:00Z"),
  )
  expect(nextRoutineDates("0 9 * * *", "America/New_York", Date.parse("2026-10-31T14:00:00Z"))[0]).toBe(
    Date.parse("2026-11-01T14:00:00Z"),
  )
  expect(nextRoutineDates("invalid", "UTC", Date.now())).toEqual([])
  expect(nextRoutineDates("0 9 * * *", "invalid", Date.now())).toEqual([])
  expect(simpleCron(required(simpleSchedule("30 8 * * 1,3,5")))).toBe("30 8 * * 1,3,5")
})

it("does not propose a routine without a completed useful result", () => {
  const f = fixture()
  expect(repeatTaskDraft(f.bot, required(f.state.threads[0]), [])).toBeNull()
  expect(
    repeatTaskDraft(
      f.bot,
      required(f.state.threads[0]),
      f.state.messages.map((message) => ({ ...message, status: "failed" })),
    ),
  ).toBeNull()
  expect(t("Agendar esta tarefa", {}, "en")).toBe("Schedule this task")
  expect(t("Quando?", {}, "en")).toBe("When?")
  expect(t("succeeded")).toBe("concluído")
  expect(t("succeeded", {}, "en")).toBe("Completed")
})

it("recurring job templates suggest a filled paused draft without saving anything", () => {
  const f = fixture()
  const template = required(getJobTemplates().find((job) => job.id === "team-update"))
  expect(
    suggestedRoutineDraft({ ...f.bot, roleLine: template.roleLine, instructions: template.instructions }),
  ).toMatchObject({ botId: f.bot.id, prompt: template.instructions, cron: "0 9 * * 1-5", enabled: false })
  expect(f.api.calls).toEqual([])
})

it("reviews a dedicated results conversation accurately without claiming another conversation's history", () => {
  const f = fixture()
  render(<RoutineEditor initial={f.draft} bots={[f.bot]} actions={f.actions} host="mac" onClose={vi.fn()} />)
  fireEvent.change(screen.getByLabelText("Destino dos resultados"), { target: { value: "results-thread" } })
  fireEvent.click(screen.getByRole("button", { name: "Revisar rotina" }))
  expect(screen.getByRole("region", { name: "Revisar rotina" })).toHaveFocus()
  expect(screen.getByText("Conversa de resultados")).toBeVisible()
  expect(screen.getByText("Permissões atuais do bot.")).toBeVisible()
  expect(screen.getByText("Funciona enquanto o touri estiver em execução neste Mac.")).toBeVisible()
})

it("keeps a rejected update open and never enables it on cancel", async () => {
  const f = fixture()
  const close = vi.fn()
  f.actions.updateRoutine.mockRejectedValueOnce(new Error("save failed"))
  render(
    <RoutineEditor
      initial={f.draft}
      routineId={f.created.id}
      bots={[f.bot]}
      actions={f.actions}
      host="server"
      onClose={close}
    />,
  )
  fireEvent.change(screen.getByLabelText("Tarefa"), { target: { value: "Uma tarefa revisada" } })
  fireEvent.click(screen.getByRole("button", { name: "Revisar rotina" }))
  fireEvent.click(screen.getByRole("button", { name: "Ativar rotina" }))
  await screen.findByRole("alert")
  expect(close).not.toHaveBeenCalled()
  expect(screen.getByText("Uma tarefa revisada")).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Cancelar" }))
  expect(close).toHaveBeenCalledOnce()
  expect(f.actions.updateRoutine).toHaveBeenCalledOnce()
  expect(f.actions.createRoutine).not.toHaveBeenCalled()
})

it("offers a recurring job's draft in the empty conversation without persisting the selection", async () => {
  const f = fixture()
  const template = required(getJobTemplates().find((job) => job.id === "team-update"))
  Object.assign(required(f.state.bots[0]), { roleLine: template.roleLine, instructions: template.instructions })
  f.state.messages.splice(0)
  for (const thread of f.state.threads) thread.activeLeafId = null
  render(<App kernel={{ services: { api: f.api } }} />)
  fireEvent.click(await screen.findByRole("button", { name: "Agendar esta tarefa" }, { timeout: 15000 }))
  expect(screen.getByRole("textbox", { name: "Tarefa" })).toHaveValue(template.instructions)
  expect(screen.getByLabelText("Às")).toHaveValue("09:00")
  expect(f.api.calls.filter((call) => ["POST /routines", "PATCH /routines/:id"].includes(call.route))).toEqual([])
}, 30000)

it("sends a routine to a group the bot belongs to and reviews it as a group task", async () => {
  const f = fixture()
  const other = { ...f.bot, id: "bot-other", name: "Outro" }
  const group = {
    id: "group-email",
    name: "Email Geral",
    color: "#dc2626",
    avatarShape: "classic-none" as const,
    avatarSeed: "group-email",
    memberIds: [f.bot.id, other.id],
    coordinatorBotId: null,
    createdAt: 0,
    updatedAt: 0,
  }
  const elsewhere = { ...group, id: "group-elsewhere", name: "Sem o bot", memberIds: [other.id] }
  render(
    <RoutineEditor
      initial={f.draft}
      bots={[f.bot, other]}
      groups={[group, elsewhere]}
      actions={f.actions}
      host="server"
      onClose={vi.fn()}
    />,
  )
  const destination = screen.getByLabelText("Destino dos resultados")
  expect(within(destination).getByRole("option", { name: "Conversa do grupo Email Geral" })).toBeInTheDocument()
  expect(within(destination).queryByRole("option", { name: "Conversa do grupo Sem o bot" })).toBeNull()
  fireEvent.change(destination, { target: { value: "group:group-email" } })
  fireEvent.click(screen.getByRole("button", { name: "Revisar rotina" }))
  expect(screen.getByText(/A tarefa Organizar notas será enviada ao grupo Email Geral/)).toBeVisible()
  expect(screen.getByText(/Cada membro responde com as próprias permissões/)).toBeVisible()
  expect(screen.queryByText("/workspace/notes")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Ativar rotina" }))
  await waitFor(() => expect(f.actions.createRoutine).toHaveBeenCalled())
  expect(f.actions.createRoutine.mock.calls[0]?.[0]).toMatchObject({
    groupId: "group-email",
    continuity: "results-thread",
    resultsThreadId: null,
    enabled: true,
  })
})

it("a task repeated from a group chat posts back into the same group conversation", () => {
  const f = fixture()
  const thread = { ...required(f.state.threads[0]), groupId: "group-email" }
  const group = {
    id: "group-email",
    name: "Email Geral",
    color: "#dc2626",
    avatarShape: "classic-none" as const,
    avatarSeed: "group-email",
    memberIds: ["bot-first", f.bot.id],
    coordinatorBotId: f.bot.id,
    createdAt: 0,
    updatedAt: 0,
  }
  expect(repeatTaskDraft(f.bot, thread, f.state.messages, group)).toMatchObject({
    botId: f.bot.id,
    groupId: "group-email",
    continuity: "results-thread",
    resultsThreadId: thread.id,
  })
  expect(t("Conversa do grupo {group}", { group: "Email Geral" }, "en")).toBe("Group conversation Email Geral")
})
