import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import {
  getRoutineRunCountsToday,
  getRoutineRunDateLabel,
  getRoutineRunSidebarDateLabel,
  getRoutineRunTimeLabel,
  t,
} from "../src/i18n"
import { getSidebarDataByBot, getSidebarReadThreadIds, getSidebarThreads } from "../src/sidebarThreads"
import { getRoutineSidebarFixture } from "./routine-sidebar-fixture"
import { openConversations, openWork } from "./workspaceNavigation"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it("counts today's routine executions using each routine's timezone", async () => {
  const { routineRuns, routines } = await getRoutineSidebarFixture(2)
  const routine = routines[0]
  const first = routineRuns[0]
  const second = routineRuns[1]
  if (!routine || !first || !second) throw new Error("Missing routine count fixture")
  const localRoutine = { ...routine, timezone: "America/Sao_Paulo" }
  const now = Date.parse("2026-09-22T12:00:00Z")
  const counts = getRoutineRunCountsToday(
    [
      { ...first, scheduledFor: Date.parse("2026-09-22T13:00:00Z") },
      { ...second, scheduledFor: Date.parse("2026-09-22T02:00:00Z") },
    ],
    new Map([[localRoutine.id, localRoutine]]),
    now,
  )

  expect(counts.get(routine.id)).toBe(1)
})

it("folds every routine into one Rotinas row with a single unread total that opens the history", async () => {
  const { api } = await getRoutineSidebarFixture(8, { withOtherRoutines: true, unreadRuns: 9 })

  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  const conversations = openConversations()
  const routines = within(conversations).getByRole("button", { name: /^Rotinas/ })

  expect(within(conversations).queryByRole("button", { name: /Resumo diário|Outras notícias/ })).toBeNull()
  expect(routines.querySelector(".sidebar-unread")).toHaveTextContent("9")
  expect(routines.querySelectorAll(".sidebar-unread")).toHaveLength(1)
  fireEvent.click(routines)
  await screen.findByRole("heading", { name: "Rotinas", exact: true })

  expect(document.querySelector(".routine-run-history")).toBeInTheDocument()
})

it("opening a history result clears its routine group without clearing another routine", async () => {
  const { api, routines } = await getRoutineSidebarFixture(8, { withOtherRoutines: true, unreadRuns: 9 })
  const routine = routines[0]
  if (!routine) throw new Error("Missing routine history fixture")

  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  const conversations = openConversations()
  const row = within(conversations).getByRole("button", { name: /^Rotinas/ })
  expect(row.querySelector(".sidebar-unread")).toHaveTextContent("9")

  fireEvent.click(row)
  await screen.findByRole("heading", { name: "Rotinas", exact: true })
  const history = document.querySelector(".routine-run-history")
  if (!(history instanceof HTMLElement)) throw new Error("Missing routine history")
  fireEvent.change(within(history).getByRole("combobox", { name: "Filtrar histórico por rotina" }), {
    target: { value: routine.id },
  })
  const oldest = within(history).getAllByRole("button", { name: "Abrir conversa" }).at(-1)
  if (!oldest) throw new Error("Missing oldest history result")
  fireEvent.click(oldest)

  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  const restoredRow = within(openConversations()).getByRole("button", { name: /^Rotinas/ })

  await waitFor(() => expect(restoredRow.querySelector(".sidebar-unread")).toHaveTextContent("1"))
  expect(screen.getByText("Resumo pronto para conferir.", { selector: "p" })).toBeVisible()
})

it("groups 128 deleted routine conversations and keeps every result reachable in bounded pages", async () => {
  const { api, threads } = await getRoutineSidebarFixture(128, { withoutRoutineMetadata: true, unreadRuns: 8 })
  const oldestThread = threads[1]
  if (!oldestThread) throw new Error("Missing oldest deleted result")

  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  const conversations = openConversations()
  const routine = within(conversations).getByRole("button", { name: /Rotina excluída/ })

  expect(conversations.querySelectorAll(".thread-row")).toHaveLength(2)
  expect(within(conversations).queryByRole("button", { name: "Histórico de rotinas" })).toBeNull()
  expect(routine.querySelector(".sidebar-unread")).toHaveTextContent("8")
  fireEvent.click(routine)
  await screen.findByText("Resumo pronto para conferir.", { selector: "p" })

  const currentConversations = openConversations()
  const currentRoutine = within(currentConversations).getByRole("button", { name: /Rotina excluída/ })

  await waitFor(() => expect(currentRoutine.querySelector(".sidebar-unread")).toBeNull())
  const toggle = within(currentConversations).getByRole("button", { name: "Conversas de rotinas excluídas" })
  fireEvent.click(toggle)
  const history = screen.getByRole("region", { name: "Conversas de rotinas excluídas" })

  expect(history.querySelectorAll(".thread-row")).toHaveLength(50)
  expect(within(history).getByRole("status")).toHaveTextContent("Execuções 1–50 de 128")
  fireEvent.click(within(history).getByRole("button", { name: "Próxima página" }))

  expect(history.querySelectorAll(".thread-row")).toHaveLength(50)
  expect(within(history).getByRole("status")).toHaveTextContent("Execuções 51–100 de 128")
  expect(within(history).getByRole("status")).toHaveFocus()
  fireEvent.click(within(history).getByRole("button", { name: "Próxima página" }))

  expect(history.querySelectorAll(".thread-row")).toHaveLength(28)
  expect(within(history).getByRole("status")).toHaveTextContent("Execuções 101–128 de 128")
  fireEvent.click(within(history).getByRole("button", { name: "Página anterior" }))
  fireEvent.click(within(history).getByRole("button", { name: "Página anterior" }))
  const oldest = within(history).getByText(getRoutineRunDateLabel(oldestThread.createdAt)).closest("button")
  if (!oldest) throw new Error("Missing oldest deleted result button")

  fireEvent.click(oldest)
  await screen.findByText("Resumo pronto para conferir.", { selector: "p" })
  const restoredConversations = openConversations()
  const currentToggle = within(restoredConversations).getByRole("button", { name: "Conversas de rotinas excluídas" })

  expect(currentToggle).toHaveAttribute("aria-expanded", "false")
  expect(restoredConversations.querySelectorAll(".thread-row")).toHaveLength(2)
  expect(document.querySelector(".thread-row.selected")).toHaveTextContent("08:00")
})

it("groups 28 routine executions without burying ordinary conversations and opens older results from history", async () => {
  const { api } = await getRoutineSidebarFixture()

  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  const conversations = openConversations()
  const rows = conversations.querySelectorAll(".thread-row")
  expect(rows).toHaveLength(2)
  expect(rows[0]).toHaveTextContent("Planejamento da semana")
  expect(rows[1]).toHaveTextContent("Rotinas")
  expect(rows[1]).not.toHaveTextContent(/0 hoje/)
  expect(rows[1]).toHaveTextContent("11:45")

  openWork()
  await screen.findByRole("heading", { name: "Trabalho", exact: true })

  fireEvent.click(within(openConversations()).getByRole("button", { name: /^Rotinas/ }))
  await screen.findByRole("heading", { name: "Rotinas", exact: true })
  const history = document.querySelector(".routine-run-history")
  if (!(history instanceof HTMLElement)) throw new Error("Missing run history")

  expect(history).toHaveAttribute("data-open", "true")
  expect(within(history).getByRole("status")).toHaveFocus()
  expect(within(history).getByRole("combobox", { name: "Filtrar histórico por rotina" })).not.toHaveValue("all")
  const openButtons = within(history).getAllByRole("button", { name: "Abrir conversa" })
  expect(openButtons).toHaveLength(28)
  const oldest = openButtons.at(-1)
  if (!oldest) throw new Error("Missing oldest run")

  fireEvent.click(oldest)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  const restoredConversations = openConversations()

  const selected = document.querySelector(".thread-row.selected")
  expect(selected).toHaveTextContent("05:00")
  expect(restoredConversations.querySelectorAll(".thread-row")).toHaveLength(2)
  expect(await screen.findByText("Resumo pronto para conferir.", { selector: "p" })).toBeVisible()
})

it("shows the last run date instead of a zero-today count for an idle routine", async () => {
  const fixture = await getRoutineSidebarFixture(2)
  const routine = fixture.routines[0]
  const latestRun = fixture.routineRuns.at(-1)
  if (!routine || !latestRun) throw new Error("Missing routine date fixture")

  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date(2026, 9, 20, 12))
  render(<App kernel={{ services: { api: fixture.api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  const conversations = openConversations()
  const routineRow = within(conversations).getByRole("button", { name: /^Rotinas/ })
  const lastRunLabel = getRoutineRunSidebarDateLabel(latestRun.scheduledFor, "pt-BR", routine.timezone)

  expect(routineRow).toHaveTextContent(`Rotinas${lastRunLabel}`)
  expect(routineRow).not.toHaveTextContent("0 hoje")
})

it("hides the zero-today suffix from an older task summary", async () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date(2026, 9, 20, 12))
  const api = createMockApi()
  const { thread } = await api.request("POST /threads", {
    botId: "bot-mark",
    title: "Resumo diário · abcdef123456",
  })
  await api.request("PATCH /threads/:id", { kind: "chat", unread: 0 }, { id: thread.id })
  vi.setSystemTime(new Date(2026, 9, 21, 12))

  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  const conversations = openConversations()
  const taskRow = within(conversations).getByRole("button", { name: /^Tarefas Resumo diário/ })

  expect(taskRow).not.toHaveTextContent("0 hoje")
  expect(taskRow).toHaveTextContent("ontem")
})

it("keeps routine conversations older than the first history page reachable", async () => {
  const { api } = await getRoutineSidebarFixture(60, { oldestRunMessage: "A execução mais antiga continua acessível." })

  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  fireEvent.click(within(openConversations()).getByRole("button", { name: /^Rotinas/ }))
  await screen.findByRole("heading", { name: "Rotinas", exact: true })
  const history = document.querySelector(".routine-run-history")
  if (!(history instanceof HTMLElement)) throw new Error("Missing run history")

  expect(within(history).getAllByRole("button", { name: "Abrir conversa" })).toHaveLength(50)
  fireEvent.click(within(history).getByRole("button", { name: "Próxima página" }))
  const openButtons = within(history).getAllByRole("button", { name: "Abrir conversa" })
  const oldest = openButtons.at(-1)
  if (!oldest) throw new Error("Missing oldest run")

  expect(openButtons).toHaveLength(10)
  expect(within(history).queryByRole("button", { name: "Próxima página" })).toBeNull()
  expect(within(history).getByRole("status")).toHaveTextContent("Execuções 51–60 de 60")
  fireEvent.click(oldest)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  expect(await screen.findByText("A execução mais antiga continua acessível.", { selector: "p" })).toBeVisible()
})

it("opens selected routine history across three bounded pages despite newer runs from other routines and bots", async () => {
  const { api, routines } = await getRoutineSidebarFixture(128, {
    withOtherRoutines: true,
    oldestRunMessage: "A execução mais antiga continua acessível.",
  })
  const targetRoutine = routines[0]
  if (!targetRoutine) throw new Error("Missing target routine")

  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  fireEvent.click(within(openConversations()).getByRole("button", { name: /^Rotinas/ }))
  await screen.findByRole("heading", { name: "Rotinas", exact: true })
  const history = document.querySelector(".routine-run-history")
  if (!(history instanceof HTMLElement)) throw new Error("Missing run history")
  fireEvent.change(within(history).getByRole("combobox", { name: "Filtrar histórico por rotina" }), {
    target: { value: targetRoutine.id },
  })

  expect(history).toHaveAttribute("data-open", "true")
  expect(screen.getByRole("combobox", { name: "Bot", exact: true })).toHaveValue("bot-mark")
  expect(within(history).getByRole("combobox", { name: "Filtrar histórico por rotina" })).toHaveValue(targetRoutine.id)
  expect(within(history).queryByRole("option", { name: /Resumo de outro bot/ })).toBeNull()
  expect(within(history).getByRole("status")).toHaveTextContent("Execuções 1–50 de 128")
  expect(within(history).getAllByRole("listitem")).toHaveLength(50)
  expect(within(history).queryByText("Outras notícias", { selector: "strong" })).toBeNull()

  fireEvent.click(within(history).getByRole("button", { name: "Histórico de execuções" }))
  fireEvent.click(within(openConversations()).getByRole("button", { name: /^Rotinas/ }))

  expect(history).toHaveAttribute("data-open", "true")
  fireEvent.change(within(history).getByRole("combobox", { name: "Filtrar histórico por rotina" }), {
    target: { value: targetRoutine.id },
  })

  expect(within(history).getByRole("combobox", { name: "Filtrar histórico por rotina" })).toHaveValue(targetRoutine.id)

  fireEvent.click(within(history).getByRole("button", { name: "Próxima página" }))

  expect(within(history).getAllByRole("listitem")).toHaveLength(50)
  expect(within(history).getByRole("status")).toHaveTextContent("Execuções 51–100 de 128")
  expect(within(history).getByRole("status")).toHaveFocus()

  fireEvent.click(within(history).getByRole("button", { name: "Próxima página" }))

  expect(within(history).getAllByRole("listitem")).toHaveLength(28)
  expect(within(history).getByRole("status")).toHaveTextContent("Execuções 101–128 de 128")
  expect(within(history).queryByRole("button", { name: "Próxima página" })).toBeNull()

  fireEvent.click(within(history).getByRole("button", { name: "Página anterior" }))

  expect(within(history).getByRole("status")).toHaveTextContent("Execuções 51–100 de 128")

  fireEvent.change(within(history).getByRole("combobox", { name: "Filtrar histórico por rotina" }), {
    target: { value: "another-routine" },
  })

  expect(within(history).getByRole("status")).toHaveTextContent("Execuções 1–50 de 80")
  expect(within(history).queryByRole("button", { name: "Página anterior" })).toBeNull()

  fireEvent.change(within(history).getByRole("combobox", { name: "Filtrar histórico por rotina" }), {
    target: { value: targetRoutine.id },
  })
  fireEvent.click(within(history).getByRole("button", { name: "Próxima página" }))
  fireEvent.click(within(history).getByRole("button", { name: "Próxima página" }))
  const oldest = within(history).getAllByRole("button", { name: "Abrir conversa" }).at(-1)
  if (!oldest) throw new Error("Missing oldest result")

  fireEvent.click(oldest)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  expect(await screen.findByText("A execução mais antiga continua acessível.", { selector: "p" })).toBeVisible()
})

it("reopens history from the sidebar after it was manually collapsed", async () => {
  const { api } = await getRoutineSidebarFixture()

  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  fireEvent.click(within(openConversations()).getByRole("button", { name: /^Rotinas/ }))
  const summary = await screen.findByRole("button", { name: "Histórico de execuções" })
  fireEvent.click(summary)
  fireEvent.click(within(openConversations()).getByRole("button", { name: /^Rotinas/ }))

  expect(summary.closest(".ds-disclosure")).toHaveAttribute("data-open", "true")
})

it("groups by identity across renames, keeps same-name routines separate and preserves unread results", async () => {
  const { threads, routineRuns } = await getRoutineSidebarFixture()
  const firstRun = routineRuns[0]
  const lastThread = threads.at(-1)
  if (!firstRun || !lastThread) throw new Error("Missing runs")
  const renamed = { ...lastThread, title: "Novo nome", unread: 2 }
  const sameName = { ...lastThread, id: "another-routine-thread", routineRunId: "another-run", unread: 1 }
  const anotherRun = { ...firstRun, id: "another-run", routineId: "another-routine", threadId: sameName.id }
  const originalThreads = [...threads.slice(0, -1), renamed, sameName]

  const rows = getSidebarThreads(originalThreads, [...routineRuns, anotherRun], null, new Set(["sidebar-thread-0"]))

  expect(rows.map((row) => row.thread.id)).toEqual(["thread-mark", renamed.id, sameName.id])
  expect(rows[1]?.thread.title).toBe("Novo nome")
  expect(rows[1]?.running).toBe(true)
  expect(rows[1]?.unread).toBe(2)
  expect(rows[2]?.unread).toBe(1)
  expect(originalThreads).toHaveLength(30)
})

it("collapses event task threads by trigger name and marks every reply read together", async () => {
  const { threads } = await getRoutineSidebarFixture(0)
  const mainThread = threads[0]
  if (!mainThread) throw new Error("Missing main conversation")
  const now = Date.UTC(2026, 8, 22, 12)
  const taskThreads = [
    {
      ...mainThread,
      id: "lead-one",
      kind: "chat" as const,
      title: "lead.reply · aabbccddeeff",
      createdAt: now,
      updatedAt: now,
      unread: 1,
    },
    {
      ...mainThread,
      id: "lead-two",
      kind: "chat" as const,
      title: "lead.reply · a01122334455",
      createdAt: now,
      updatedAt: now + 1,
      unread: 2,
    },
    {
      ...mainThread,
      id: "mail-one",
      kind: "chat" as const,
      title: "mail.reply · 1234567890ab",
      createdAt: now,
      updatedAt: now + 2,
      unread: 0,
    },
    {
      ...mainThread,
      id: "meeting-date",
      kind: "chat" as const,
      title: "Reunião · 2026-10-19",
      createdAt: now,
      updatedAt: now,
      unread: 0,
    },
    {
      ...mainThread,
      id: "numeric-suffix",
      kind: "chat" as const,
      title: "Tarefas · 123456789012",
      createdAt: now,
      updatedAt: now,
      unread: 0,
    },
  ]
  const rows = getSidebarThreads([mainThread, ...taskThreads], [], null, new Set(), undefined, new Map(), now)
  const leads = rows.find((row) => row.taskGroupName === "lead.reply")

  expect(rows).toHaveLength(5)
  expect(leads).toMatchObject({ countToday: 2, unread: 3 })
  expect(rows.find((row) => row.thread.id === "meeting-date")?.taskGroupName).toBeUndefined()
  expect(rows.find((row) => row.thread.id === "numeric-suffix")?.taskGroupName).toBeUndefined()
  expect(getSidebarReadThreadIds([mainThread, ...taskThreads], [], "lead-one")).toEqual(
    new Set(["lead-one", "lead-two"]),
  )
})

it("uses the run time rather than later replies and keeps a selected older run in its single row", async () => {
  const { threads, routineRuns } = await getRoutineSidebarFixture()
  const oldest = threads[1]
  if (!oldest) throw new Error("Missing oldest run")
  const withReply = threads.map((thread) =>
    thread.id === oldest.id ? { ...thread, updatedAt: Date.now() + 86_400_000 } : thread,
  )

  const latestRows = getSidebarThreads(withReply, routineRuns, null)
  const selectedRows = getSidebarThreads(withReply, routineRuns, oldest.id)

  expect(latestRows[1]?.thread.id).toBe("sidebar-thread-27")
  expect(selectedRows[1]?.thread.id).toBe(oldest.id)
  expect(selectedRows).toHaveLength(2)
})

it("indexes only each bot's own routine runs and keeps the newest metadata without sorting inputs", async () => {
  const { threads, routineRuns } = await getRoutineSidebarFixture(8, { withOtherRoutines: true })
  const latest = routineRuns[7]
  if (!latest) throw new Error("Missing latest run")
  const olderMetadata = { ...latest, id: "older-metadata", scheduledFor: latest.scheduledFor - 1 }
  const runs = [latest, olderMetadata, ...routineRuns.slice(0, 7), ...routineRuns.slice(8)]

  const byBot = getSidebarDataByBot(threads, runs)
  const mark = byBot.get("bot-mark")
  if (!mark) throw new Error("Missing bot sidebar")
  const rows = getSidebarThreads(mark.threads, mark.routineRuns, null)

  expect(mark.routineRuns).toHaveLength(89)
  expect(mark.threads.every((thread) => thread.botId === "bot-mark")).toBe(true)
  expect(mark.routineRuns.some((run) => run.routineId === "other-bot-routine")).toBe(false)
  expect(rows.find((row) => row.thread.id === latest.threadId)?.routineRun).toEqual(latest)
  expect(runs[0]).toBe(latest)
  expect(runs[1]).toBe(olderMetadata)
})

it("marks only visible runs of the opened group, including a selected older result", async () => {
  const { threads, routineRuns, routines } = await getRoutineSidebarFixture(8, { withOtherRoutines: true })
  const oldest = threads[1]
  if (!oldest) throw new Error("Missing oldest run")
  const archived = { ...oldest, id: "archived-result", archivedAt: 1 }
  const groupThread = { ...oldest, id: "group-result", groupId: "group" }
  const routineIds = new Set(routines.map((routine) => routine.id))
  const allThreads = [...threads, archived, groupThread]

  const readIds = getSidebarReadThreadIds(allThreads, routineRuns, oldest.id, routineIds)
  const ordinaryReadIds = getSidebarReadThreadIds(allThreads, routineRuns, "thread-mark", routineIds)

  expect([...readIds]).toEqual(Array.from({ length: 8 }, (_, index) => `sidebar-thread-${index}`))
  expect([...ordinaryReadIds]).toEqual(["thread-mark"])
})

it("keeps results grouped immediately after deletion while old run metadata is still loaded", async () => {
  const { threads, routineRuns } = await getRoutineSidebarFixture(8)

  const rows = getSidebarThreads(threads, routineRuns, null, new Set(), new Set())

  expect(rows).toHaveLength(2)
  expect(rows[1]?.deletedRoutine).toBe(true)
  expect(rows[1]?.thread.id).toBe("sidebar-thread-7")
})

it("shows routine run time in the routine timezone in the sidebar", async () => {
  const api = createMockApi({ scenario: "routine-conversation" })

  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  openConversations()

  const row = document.querySelector(".thread-row.selected")

  expect(row).toHaveTextContent("16:04")
  expect(row?.querySelector(".thread-meta")).toHaveTextContent("16:04")
  expect(document.querySelector(".routine-run-marker time")).toHaveTextContent("16:04")
  expect(document.querySelector(".routine-run-marker time")?.getAttribute("title")).toContain("16:04")

  const conversations = openConversations()
  fireEvent.click(within(conversations).getByRole("button", { name: /^Rotinas/ }))
  await screen.findByRole("heading", { name: "Rotinas" })
  const history = document.querySelector(".routine-run-history")

  expect(history).toHaveTextContent("17/10/2026, 16:04")
})

it("excludes archived and group threads, preserves missing metadata and leaves main-thread continuity alone", async () => {
  const { threads, routineRuns } = await getRoutineSidebarFixture()
  const routineThread = threads[1]
  const mainThread = threads[0]
  const run = routineRuns[0]
  if (!routineThread || !mainThread || !run) throw new Error("Missing threads")
  const orphan = { ...routineThread, id: "orphan", routineRunId: null }
  const archived = { ...routineThread, id: "archived", archivedAt: 1 }
  const grouped = { ...routineThread, id: "grouped", groupId: "group" }
  const mainRun = { ...run, threadId: mainThread.id }

  const rows = getSidebarThreads([mainThread, routineThread, orphan, archived, grouped], [mainRun], null)

  expect(rows).toHaveLength(3)
  expect(rows.map((row) => row.thread.id)).toEqual(expect.arrayContaining([mainThread.id, routineThread.id, orphan.id]))
  expect(rows[0]?.routineRun).toBeUndefined()
  expect(getSidebarThreads([routineThread, orphan], [], null)).toHaveLength(1)
})

it("labels routine times and navigation in Portuguese and English", () => {
  const timestamp = new Date(2026, 9, 18, 14, 45).getTime()
  const scheduledFor = Date.UTC(2026, 9, 17, 19, 4)
  const now = Date.UTC(2026, 9, 18, 12)
  const routineTimeZone = "America/Sao_Paulo"

  expect(getRoutineRunDateLabel(timestamp, "pt-BR")).toBe("18/10/2026, 14:45")
  expect(getRoutineRunDateLabel(timestamp, "en")).toBe("10/18/26, 2:45 PM")
  expect(getRoutineRunDateLabel(scheduledFor, "pt-BR", routineTimeZone)).toBe("17/10/2026, 16:04")
  expect(getRoutineRunDateLabel(scheduledFor, "en", routineTimeZone)).toBe("10/17/26, 4:04 PM")
  expect(getRoutineRunTimeLabel(scheduledFor, "pt-BR", routineTimeZone)).toBe("16:04")
  expect(getRoutineRunTimeLabel(scheduledFor, "en", routineTimeZone)).toBe("4:04 PM")
  expect(getRoutineRunSidebarDateLabel(scheduledFor, "pt-BR", routineTimeZone, now)).toBe("ontem · 16:04")
  expect(getRoutineRunSidebarDateLabel(scheduledFor, "en", routineTimeZone, now)).toBe("yesterday · 4:04 PM")
  expect(
    getRoutineRunSidebarDateLabel(Date.UTC(2026, 9, 18, 2, 30), "pt-BR", routineTimeZone, Date.UTC(2026, 9, 18, 23)),
  ).toBe("ontem · 23:30")
  expect(t("Routine run history", {}, "pt-BR")).toBe("Histórico de rotinas")
  expect(t("Routine run history", {}, "en")).toBe("Routine run history")
  expect(t("Open routine conversation", {}, "en")).toBe("Open conversation")
  expect(t("Next routine runs page", {}, "pt-BR")).toBe("Próxima página")
  expect(t("Next routine runs page", {}, "en")).toBe("Next page")
  expect(t("Previous routine runs page", {}, "en")).toBe("Previous page")
  expect(t("Routine history filter", {}, "en")).toBe("Filter history by routine")
  expect(t("All routines", {}, "en")).toBe("All routines")
  expect(t("Deleted routine", {}, "pt-BR")).toBe("Rotina excluída")
  expect(t("Deleted routine", {}, "en")).toBe("Deleted routine")
  expect(t("Deleted routine conversations", {}, "pt-BR")).toBe("Conversas de rotinas excluídas")
  expect(t("Deleted routine conversations", {}, "en")).toBe("Deleted routine conversations")
  expect(t("Routine history range", { from: 51, to: 60, total: 60 }, "en")).toBe("Runs 51–60 of 60")
})
