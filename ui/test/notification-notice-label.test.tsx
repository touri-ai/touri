import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import type { NotificationRecord } from "@touri/contracts"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type NotificationActions, NotificationBell } from "../src/components/NotificationCenter"
import type { Locale } from "../src/i18n"
import * as i18n from "../src/i18n"

const getTranslation = i18n.t

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const getNotice = (botId: string | null, botName: string | null): NotificationRecord => ({
  id: 829,
  kind: "notice",
  level: "info",
  botId,
  botName,
  botColor: "#3b93f0",
  avatarShape: "classic-none",
  threadId: "channel-review",
  requestId: null,
  title: "Publicação pronta",
  body: "A revisão está disponível no canal.",
  createdAt: Date.now(),
  resolvedAt: null,
  resolution: null,
})

const renderNotice = (notice: NotificationRecord, locale: Locale) => {
  vi.spyOn(i18n, "t").mockImplementation((key, params) => getTranslation(key, params, locale))
  const actions: NotificationActions = {
    open: vi.fn(),
    dismiss: vi.fn().mockResolvedValue(undefined),
    dismissAll: vi.fn(),
    respond: vi.fn(),
    reply: vi.fn(),
  }
  render(<NotificationBell notifications={[notice]} actions={actions} />)
  fireEvent.click(screen.getByRole("button", { name: getTranslation("Notifications", {}, locale) }))

  return { actions, row: screen.getByTestId("notification-row") }
}

describe.each<{ locale: Locale; neutralLabel: string; botLabel: string }>([
  { locale: "pt-BR", neutralLabel: "Aviso", botLabel: "Aviso do bot" },
  { locale: "en", neutralLabel: "Notice", botLabel: "Bot notice" },
])("notice presentation in $locale", ({ locale, neutralLabel, botLabel }) => {
  it.each([
    { botId: null, botName: null, hasBot: false },
    { botId: null, botName: "Ateliê", hasBot: false },
    { botId: "bot-a", botName: "Ateliê", hasBot: true },
  ])("labels botId=$botId and display name=$botName without changing the notice", ({ botId, botName, hasBot }) => {
    const notice = getNotice(botId, botName)

    const { actions, row } = renderNotice(notice, locale)

    expect(row.querySelector(".ds-badge")?.textContent).toBe(hasBot ? botLabel : neutralLabel)
    expect(row.querySelector(".ds-badge")).toHaveClass("ds-badge-neutral")
    expect(row.querySelector(".notification-head strong")).toHaveTextContent(botName ?? "touri")
    expect(row.querySelector(".notification-title")).toHaveTextContent(notice.title)
    expect(row.querySelector(".notification-body")).toHaveTextContent(notice.body)
    expect(row).toHaveAttribute("data-unread", "false")
    expect(within(row).queryByRole("textbox")).toBeNull()

    fireEvent.click(within(row).getByRole("button", { name: getTranslation("Ver conversa", {}, locale) }))

    expect(actions.open).toHaveBeenCalledWith(notice)
    expect(actions.respond).not.toHaveBeenCalled()
    expect(actions.reply).not.toHaveBeenCalled()
  })
})
