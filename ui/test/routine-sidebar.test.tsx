import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import App from "../src/App"
import { getRoutineRunDateLabel, t } from "../src/i18n"
import { getSidebarThreads } from "../src/sidebarThreads"
import { getRoutineSidebarFixture } from "./routine-sidebar-fixture"

afterEach(cleanup)

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
  fireEvent.click(screen.getByText("Histórico de execuções", { selector: "summary" }))
  const history = document.querySelector(".routine-run-history")
  if (!(history instanceof HTMLElement)) throw new Error("Missing run history")

  const openButtons = within(history).getAllByRole("button", { name: "Abrir conversa" })
  expect(openButtons).toHaveLength(28)
  const oldest = openButtons.at(-1)
  if (!oldest) throw new Error("Missing oldest run")

  fireEvent.click(oldest)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  const selected = document.querySelector(".thread-row.selected")
  expect(selected).toHaveTextContent("08:00")
  expect(document.querySelectorAll('[data-bot-entry="bot-mark"] .thread-row')).toHaveLength(2)
  expect(await screen.findByText("Resumo pronto para conferir.")).toBeVisible()
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

  expect(rows.map((row) => row.thread.id)).toEqual([mainThread.id, routineThread.id, orphan.id])
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
})
