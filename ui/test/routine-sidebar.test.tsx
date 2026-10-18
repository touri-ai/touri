import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import App from "../src/App"
import { getRoutineRunDateLabel, t } from "../src/i18n"
import { getSidebarDataByBot, getSidebarReadThreadIds, getSidebarThreads } from "../src/sidebarThreads"
import { getRoutineSidebarFixture } from "./routine-sidebar-fixture"

afterEach(cleanup)

it("clears every unread run when opening its routine group and leaves another routine unread", async () => {
  const { api } = await getRoutineSidebarFixture(8, { withOtherRoutines: true, unreadRuns: 9 })

  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  const conversations = screen.getByRole("region", { name: "Conversas de mark" })
  const routine = within(conversations).getByRole("button", { name: /Resumo diário/ })
  const otherRoutine = within(conversations).getByRole("button", { name: /Outras notícias/ })

  expect(routine.querySelector(".sidebar-unread")).toHaveTextContent("8")
  fireEvent.click(routine)
  await screen.findByText("Resumo pronto para conferir.", { selector: "p" })

  await waitFor(() => expect(routine.querySelector(".sidebar-unread")).toBeNull())
  expect(otherRoutine.querySelector(".sidebar-unread")).toHaveTextContent("1")
  fireEvent.click(routine)

  expect(routine.querySelector(".sidebar-unread")).toBeNull()
  expect(document.querySelector(".thread-row.selected")).toHaveTextContent("09:45")
})

it("keeps every deleted routine conversation reachable after its run metadata is removed", async () => {
  const { api } = await getRoutineSidebarFixture(28, { withoutRoutineMetadata: true, unreadRuns: 8 })

  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  const conversations = screen.getByRole("region", { name: "Conversas de mark" })
  const routineRows = within(conversations).getAllByRole("button", { name: /Rotina excluída/ })
  const oldest = routineRows.at(-1)
  const nextOldest = routineRows.at(-2)
  if (!oldest || !nextOldest) throw new Error("Missing deleted routine results")

  expect(conversations.querySelectorAll(".thread-row")).toHaveLength(29)
  expect(routineRows).toHaveLength(28)
  expect(within(conversations).queryByRole("button", { name: "Histórico de rotinas" })).toBeNull()
  expect(oldest.querySelector(".sidebar-unread")).toHaveTextContent("1")

  fireEvent.click(oldest)
  await screen.findByText("Resumo pronto para conferir.", { selector: "p" })

  await waitFor(() => expect(oldest.querySelector(".sidebar-unread")).toBeNull())
  expect(nextOldest.querySelector(".sidebar-unread")).toHaveTextContent("1")
  expect(document.querySelector(".thread-row.selected")).toHaveTextContent("08:00")
})

it("groups 28 routine executions without burying ordinary conversations and opens older results from history", async () => {
  const { api } = await getRoutineSidebarFixture()

  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  const conversations = screen.getByRole("region", { name: "Conversas de mark" })
  const rows = conversations.querySelectorAll(".thread-row")
  expect(rows).toHaveLength(2)
  expect(rows[0]).toHaveTextContent("Planejamento da semana")
  expect(rows[1]).toHaveTextContent("Resumo diário")
  expect(rows[1]).toHaveTextContent("14:45")

  fireEvent.click(within(conversations).getByRole("button", { name: "Histórico de rotinas" }))
  await screen.findByRole("heading", { name: "Rotinas", exact: true })
  const history = document.querySelector(".routine-run-history")
  if (!(history instanceof HTMLElement)) throw new Error("Missing run history")

  expect(history).toHaveAttribute("open")
  expect(within(history).getByRole("status")).toHaveFocus()
  expect(within(history).getByRole("combobox", { name: "Filtrar histórico por rotina" })).not.toHaveValue("all")
  const openButtons = within(history).getAllByRole("button", { name: "Abrir conversa" })
  expect(openButtons).toHaveLength(28)
  const oldest = openButtons.at(-1)
  if (!oldest) throw new Error("Missing oldest run")

  fireEvent.click(oldest)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  const selected = document.querySelector(".thread-row.selected")
  expect(selected).toHaveTextContent("08:00")
  expect(document.querySelectorAll('[data-bot-entry="bot-mark"] .thread-row')).toHaveLength(2)
  expect(await screen.findByText("Resumo pronto para conferir.", { selector: "p" })).toBeVisible()
})

it("keeps routine conversations older than the first history page reachable", async () => {
  const { api } = await getRoutineSidebarFixture(60)

  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  fireEvent.click(screen.getByRole("button", { name: "Histórico de rotinas" }))
  await screen.findByRole("heading", { name: "Rotinas", exact: true })
  const history = document.querySelector(".routine-run-history")
  if (!(history instanceof HTMLElement)) throw new Error("Missing run history")

  expect(within(history).getAllByRole("button", { name: "Abrir conversa" })).toHaveLength(50)
  fireEvent.click(within(history).getByRole("button", { name: "Carregar mais" }))
  const openButtons = within(history).getAllByRole("button", { name: "Abrir conversa" })
  const oldest = openButtons.at(-1)
  if (!oldest) throw new Error("Missing oldest run")

  expect(openButtons).toHaveLength(10)
  expect(within(history).queryByRole("button", { name: "Carregar mais" })).toBeNull()
  expect(within(history).getByRole("status")).toHaveTextContent("Execuções 51–60 de 60")
  fireEvent.click(oldest)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  expect(document.querySelector(".thread-row.selected")).toHaveTextContent("08:00")
  expect(await screen.findByText("Resumo pronto para conferir.", { selector: "p" })).toBeVisible()
})

it("opens selected routine history across three bounded pages despite newer runs from other routines and bots", async () => {
  const { api, routines } = await getRoutineSidebarFixture(128, { withOtherRoutines: true })
  const targetRoutine = routines[0]
  if (!targetRoutine) throw new Error("Missing target routine")

  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  const conversations = screen.getByRole("region", { name: "Conversas de mark" })
  fireEvent.click(within(conversations).getByText("Resumo diário", { selector: "strong" }))
  await screen.findByText("Resumo pronto para conferir.", { selector: "p" })
  fireEvent.click(within(conversations).getByRole("button", { name: "Histórico de rotinas" }))
  await screen.findByRole("heading", { name: "Rotinas", exact: true })
  const history = document.querySelector(".routine-run-history")
  if (!(history instanceof HTMLElement)) throw new Error("Missing run history")

  expect(history).toHaveAttribute("open")
  expect(screen.getByRole("button", { name: "mark", exact: true })).toHaveAttribute("aria-pressed", "true")
  expect(within(history).getByRole("combobox", { name: "Filtrar histórico por rotina" })).toHaveValue(targetRoutine.id)
  expect(within(history).queryByRole("option", { name: /Resumo de outro bot/ })).toBeNull()
  expect(within(history).getByRole("status")).toHaveTextContent("Execuções 1–50 de 128")
  expect(within(history).getAllByRole("listitem")).toHaveLength(50)
  expect(within(history).queryByText("Outras notícias", { selector: "strong" })).toBeNull()

  fireEvent.click(within(history).getByText("Histórico de execuções", { selector: "summary" }))
  fireEvent.click(within(conversations).getByRole("button", { name: "Histórico de rotinas" }))

  expect(history).toHaveAttribute("open")
  expect(within(history).getByRole("combobox", { name: "Filtrar histórico por rotina" })).toHaveValue(targetRoutine.id)

  fireEvent.click(within(history).getByRole("button", { name: "Carregar mais" }))

  expect(within(history).getAllByRole("listitem")).toHaveLength(50)
  expect(within(history).getByRole("status")).toHaveTextContent("Execuções 51–100 de 128")
  expect(within(history).getByRole("status")).toHaveFocus()

  fireEvent.click(within(history).getByRole("button", { name: "Carregar mais" }))

  expect(within(history).getAllByRole("listitem")).toHaveLength(28)
  expect(within(history).getByRole("status")).toHaveTextContent("Execuções 101–128 de 128")
  expect(within(history).queryByRole("button", { name: "Carregar mais" })).toBeNull()

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
  fireEvent.click(within(history).getByRole("button", { name: "Carregar mais" }))
  fireEvent.click(within(history).getByRole("button", { name: "Carregar mais" }))
  const oldest = within(history).getAllByRole("button", { name: "Abrir conversa" }).at(-1)
  if (!oldest) throw new Error("Missing oldest result")

  fireEvent.click(oldest)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  expect(document.querySelector(".thread-row.selected")).toHaveTextContent("08:00")
  expect(await screen.findByText("Resumo pronto para conferir.", { selector: "p" })).toBeVisible()
})

it("reopens history from the sidebar after it was manually collapsed", async () => {
  const { api } = await getRoutineSidebarFixture()

  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  fireEvent.click(screen.getByRole("button", { name: "Histórico de rotinas" }))
  const summary = await screen.findByText("Histórico de execuções", { selector: "summary" })
  fireEvent.click(summary)
  fireEvent.click(screen.getByRole("button", { name: "Histórico de rotinas" }))

  expect(summary.closest("details")).toHaveAttribute("open")
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

it("keeps every result reachable immediately after deletion while old run metadata is still loaded", async () => {
  const { threads, routineRuns } = await getRoutineSidebarFixture(8)

  const rows = getSidebarThreads(threads, routineRuns, null, new Set(), new Set())

  expect(rows).toHaveLength(9)
  expect(rows[1]?.deletedRoutine).toBe(true)
  expect(rows[1]?.thread.id).toBe("sidebar-thread-7")
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
  expect(getSidebarThreads([routineThread, orphan], [], null)).toHaveLength(2)
})

it("labels routine times and navigation in Portuguese and English", () => {
  const timestamp = new Date(2026, 9, 18, 14, 45).getTime()

  expect(getRoutineRunDateLabel(timestamp, "pt-BR")).toBe("18/10/2026, 14:45")
  expect(getRoutineRunDateLabel(timestamp, "en")).toBe("10/18/26, 2:45 PM")
  expect(t("Routine run history", {}, "pt-BR")).toBe("Histórico de rotinas")
  expect(t("Routine run history", {}, "en")).toBe("Routine run history")
  expect(t("Open routine conversation", {}, "en")).toBe("Open conversation")
  expect(t("Show more routine runs", {}, "pt-BR")).toBe("Carregar mais")
  expect(t("Show more routine runs", {}, "en")).toBe("Load more")
  expect(t("Previous routine runs page", {}, "en")).toBe("Previous page")
  expect(t("Routine history filter", {}, "en")).toBe("Filter history by routine")
  expect(t("All routines", {}, "en")).toBe("All routines")
  expect(t("Deleted routine", {}, "pt-BR")).toBe("Rotina excluída")
  expect(t("Deleted routine", {}, "en")).toBe("Deleted routine")
  expect(t("Routine history range", { from: 51, to: 60, total: 60 }, "en")).toBe("Runs 51–60 of 60")
})
