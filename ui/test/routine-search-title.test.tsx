import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { CommandPalette } from "../src/features/commandPalette/CommandPalette"
import { buildMessageIndex, buildPaletteIndex, searchPalette } from "../src/features/commandPalette/paletteItems"
import type { Locale } from "../src/i18n"
import * as i18n from "../src/i18n"
import { getRoutineSearchFixture } from "./routine-search-fixture"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it.each<[Locale, string]>([
  ["pt-BR", "Checagem de QA no canal · 23/10/2026, 02:00"],
  ["en", "Checagem de QA no canal · 10/23/26, 2:00 AM"],
])("localizes saved automatic titles in recent entries, search and message details in %s", (locale, label) => {
  const { bot, thread, message } = getRoutineSearchFixture()
  const index = buildPaletteIndex({ bots: [bot], threads: [thread], settings: [], hasBot: true, locale })
  const messages = buildMessageIndex([message], [thread], locale)
  const getGroups = (query: string, recentIds: string[] = []) => searchPalette({ index, query, messages, recentIds })

  const recent = getGroups("", [`thread:${thread.id}`])[0]?.items[0]
  const match = getGroups("10/23/26").find((group) => group.id === "threads")?.items[0]
  const localized = getGroups(locale === "pt-BR" ? "23/10/2026" : "10/23/26")
  const hit = getGroups("relatório").find((group) => group.id === "messages")?.items[0]

  expect(recent?.label).toBe(label)
  expect(match?.label).toBe(label)
  expect(localized.find((group) => group.id === "threads")?.items[0]?.label).toBe(label)
  expect(hit?.detail).toBe(label)
  expect(match?.command).toEqual({ kind: "thread", threadId: thread.id, archived: false })
  expect(thread.title).toBe("Checagem de QA no canal · 10/23/26, 2:00 AM")
})

it("keeps manual names, stale metadata and legacy titles without an identified execution intact", () => {
  const { bot, thread } = getRoutineSearchFixture()
  const titles = ["Minha revisão · 10/23/26, 2:00 AM", "Revisão da equipe", thread.title]
  const threads = titles.map((title, index) => ({
    ...thread,
    id: `manual-${index}`,
    title,
    routineTitle: index === 2 ? undefined : thread.routineTitle,
  }))

  const index = buildPaletteIndex({ bots: [bot], threads, settings: [], hasBot: true })

  expect(index.items.filter((item) => item.group === "threads").map((item) => item.label)).toEqual(titles)
})

it("uses the app language when the caller does not override the locale", () => {
  const { bot, thread } = getRoutineSearchFixture()
  vi.spyOn(document.documentElement, "lang", "get").mockReturnValue("en")
  render(
    <CommandPalette
      open
      bots={[bot]}
      threads={[thread]}
      messages={[]}
      settings={[]}
      hasBot
      onClose={() => undefined}
      onRun={() => undefined}
    />,
  )

  expect(screen.getByText("Checagem de QA no canal · 10/23/26, 2:00 AM")).toBeVisible()
  expect(screen.queryByText("Checagem de QA no canal · 23/10/2026, 02:00")).toBeNull()
})

it("uses the scheduled instant and routine timezone across a day boundary", () => {
  const { bot, thread } = getRoutineSearchFixture()
  const at = Date.UTC(2026, 9, 23, 1)
  const zoned = {
    ...thread,
    title: "Checagem de QA no canal · 10/22/26, 10:00 PM",
    routineTitle: {
      ...thread.routineTitle,
      sourceTitle: "Checagem de QA no canal · 10/22/26, 10:00 PM",
      scheduledFor: at,
    },
  }

  const index = buildPaletteIndex({ bots: [bot], threads: [zoned], settings: [], hasBot: true })

  expect(index.byId.get(`thread:${thread.id}`)?.label).toBe("Checagem de QA no canal · 22/10/2026, 22:00")
})

it.each<[Locale, string]>([
  ["pt-BR", "Checagem de QA no canal · 23/10/2026, 02:00"],
  ["en", "Checagem de QA no canal · 10/23/26, 2:00 AM"],
])("localizes authorized remote archived matches and message details in %s", async (locale, title) => {
  const { bot, thread } = getRoutineSearchFixture()
  const archived = { ...thread, archivedAt: thread.createdAt }
  const api = createMockApi()
  const request = vi.spyOn(api, "request").mockResolvedValue({
    threads: [archived],
    hits: [{ threadId: thread.id, messageId: "qa-match", snippet: "relatório sintético", thread: archived }],
  })
  const onRun = vi.fn()
  render(
    <CommandPalette
      api={api}
      open
      bots={[bot]}
      threads={[]}
      messages={[]}
      settings={[]}
      hasBot
      locale={locale}
      onClose={() => undefined}
      onRun={onRun}
    />,
  )

  fireEvent.change(screen.getByRole("combobox"), { target: { value: "relatório" } })

  await waitFor(() => expect(screen.getAllByText(title)).toHaveLength(2))
  fireEvent.click(screen.getAllByRole("option")[0] as HTMLElement)
  expect(onRun).toHaveBeenCalledWith({ kind: "thread", threadId: thread.id, archived: true })
  expect(request).toHaveBeenCalledWith("GET /search", { q: "relatório" })
})

it("retains presentation through ordinary live thread updates and drops it after a manual rename", async () => {
  const api = createMockApi()
  const { thread } = getRoutineSearchFixture()
  const state = api.getState()
  const originalRequest = api.request
  vi.spyOn(api, "request").mockImplementation(async (route, input, params) => {
    const response = await originalRequest(route, input, params)
    if (route !== "GET /bots/:id/threads") return response
    const threads = state.threads.filter((candidate) => candidate.botId === params?.id)

    return { threads: [...threads, ...(params?.id === thread.botId ? [thread] : [])] } as typeof response
  })
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  fireEvent.keyDown(window, { key: "k", ctrlKey: true })
  await screen.findByRole("combobox")
  const { routineTitle: _identity, ...update } = thread

  act(() => api.emit({ type: "thread.updated", thread: { ...update, updatedAt: thread.updatedAt + 1 } }))

  await screen.findByText("Checagem de QA no canal · 23/10/2026, 02:00")

  act(() =>
    api.emit({
      type: "thread.updated",
      thread: { ...update, title: "Minha revisão · 10/23/26, 2:00 AM", updatedAt: thread.updatedAt + 2 },
    }),
  )

  await screen.findByText("Minha revisão · 10/23/26, 2:00 AM")
  expect(screen.queryByText("Checagem de QA no canal · 23/10/2026, 02:00")).toBeNull()
})

it("presents the first live arrival of a routine conversation without a reload", async () => {
  const api = createMockApi()
  const { thread } = getRoutineSearchFixture()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  act(() => api.emit({ type: "thread.updated", thread }))
  fireEvent.keyDown(window, { key: "k", ctrlKey: true })

  await screen.findByText("Checagem de QA no canal · 23/10/2026, 02:00")
})

it("reuses prepared date labels during message updates and typing", () => {
  const { bot, thread, message } = getRoutineSearchFixture()
  const dates = vi.spyOn(i18n, "getRoutineRunDateLabel")
  const bots = [bot]
  const threads = [thread]
  const props = {
    open: true,
    bots,
    threads,
    settings: [],
    hasBot: true,
    onClose: () => undefined,
    onRun: () => undefined,
  }
  const view = render(<CommandPalette {...props} messages={[message]} />)
  expect(dates).toHaveBeenCalledTimes(1)
  dates.mockClear()

  view.rerender(<CommandPalette {...props} messages={[{ ...message, text: "relatório atualizado" }]} />)
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "relatório" } })

  expect(dates).not.toHaveBeenCalled()
})
