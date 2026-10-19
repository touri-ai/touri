import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, test } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { DeleteBotDialog } from "../src/components/DeleteBotDialog"
import { setDocumentLanguage } from "../src/documentLanguage"
import { ApiError } from "../src/errors"
import { t } from "../src/i18n"
import { getBotDeletionFixture } from "./fixtures/botDeletion"
import { showBotSettings } from "./workspaceNavigation"

afterEach(() => {
  cleanup()
  setDocumentLanguage("pt-BR", document.documentElement)
})

test("deletion failures explain the blocked step and keep the dialog available for retry", async () => {
  const bot = createMockApi().getState().bots[0]
  if (!bot) throw new Error("Missing fixture bot")
  const error = new ApiError(409, "private deletion diagnostic", "TOURI-E8004")
  render(
    <DeleteBotDialog
      bot={bot}
      onDelete={async () => {
        throw error
      }}
      onClose={() => {}}
    />,
  )

  fireEvent.change(screen.getByLabelText(`Digite o nome do bot: ${bot.name}`), { target: { value: bot.name } })
  fireEvent.click(screen.getByRole("button", { name: "Excluir bot" }))

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "O computador do bot ainda está em uso. Pare as tarefas e tente excluir novamente. [TOURI-E8004]",
  )
  expect(screen.getByRole("alert")).not.toHaveTextContent("private deletion diagnostic")
  await waitFor(() => expect(screen.getByRole("button", { name: "Excluir bot" })).toBeEnabled())
  expect(t("O computador do bot ainda está em uso. Pare as tarefas e tente excluir novamente.", {}, "en")).toBe(
    "The bot's computer is still in use. Stop the tasks and try deleting again.",
  )
})

test.each([
  { entry: "settings", locale: "pt-BR" },
  { entry: "sidebar", locale: "pt-BR" },
  { entry: "settings", locale: "en" },
  { entry: "sidebar", locale: "en" },
] as const)("$entry deletion keeps the $locale notice after bot.deleted precedes 409", async ({ entry, locale }) => {
  const fixture = getBotDeletionFixture()
  const originalIds = fixture.api.getState().bots.map((bot) => bot.id)
  setDocumentLanguage(locale, document.documentElement)
  render(<App kernel={{ services: { api: fixture.api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  openDeletion(entry)

  const dialog = screen.getByRole("dialog", { name: "Excluir bot" })
  fireEvent.change(within(dialog).getByLabelText("Digite o nome do bot: mark"), { target: { value: "mark" } })
  fireEvent.click(within(dialog).getByRole("button", { name: "Excluir bot" }))

  // The HTTP response is still suspended while the event removes the bot and its UI.
  await waitFor(() => expect(document.querySelector('[data-bot-entry="bot-mark"]')).toBeNull())
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(document.querySelector('[data-bot-entry="bot-onb"]')).not.toBeNull()

  await act(async () => fixture.finishCleanup())

  const message =
    locale === "en"
      ? "The bot was deleted, but private attachment cleanup is pending. touri will automatically try to finish the cleanup."
      : "O bot foi excluído, mas a limpeza dos anexos privados está pendente. O touri tentará concluir a limpeza automaticamente."
  expect(await screen.findByText(message)).toBeVisible()
  expect(screen.getByText(message).closest('[role="status"]')).toHaveClass("notice-info")
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(document.body).not.toHaveTextContent("private cleanup diagnostic")
  expect(fixture.api.getState().bots.map((bot) => bot.id)).toEqual(originalIds.filter((id) => id !== "bot-mark"))
  expect(fixture.api.calls.filter((call) => call.route === "DELETE /bots/:id")).toHaveLength(1)

  fireEvent.click(screen.getByRole("button", { name: "Dispensar aviso" }))

  await waitFor(() => expect(screen.queryByText(message)).toBeNull())
})

test.each(["pt-BR", "en"] as const)("the last bot's %s cleanup notice survives onboarding", async (locale) => {
  const mock = createMockApi()
  await Promise.all(
    mock
      .getState()
      .bots.filter((bot) => bot.id !== "bot-mark")
      .map((bot) => mock.request("DELETE /bots/:id", { name: bot.name }, { id: bot.id })),
  )
  const fixture = getBotDeletionFixture("pending", mock)
  setDocumentLanguage(locale, document.documentElement)
  render(<App kernel={{ services: { api: fixture.api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  openDeletion("settings")
  const dialog = screen.getByRole("dialog", { name: "Excluir bot" })

  fireEvent.change(within(dialog).getByLabelText("Digite o nome do bot: mark"), { target: { value: "mark" } })
  fireEvent.click(within(dialog).getByRole("button", { name: "Excluir bot" }))
  await waitFor(() => expect(document.querySelector(".onboarding-screen")).not.toBeNull())
  await act(async () => fixture.finishCleanup())

  expect(
    await screen.findByText(
      t(
        "O bot foi excluído, mas a limpeza dos anexos privados está pendente. O touri tentará concluir a limpeza automaticamente.",
        {},
        locale,
      ),
    ),
  ).toBeVisible()
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(fixture.api.getState().bots).toEqual([])
})

test("pending cleanup completes deletion even when the live event has not arrived", async () => {
  const fixture = getBotDeletionFixture()
  const api = {
    ...fixture.api,
    subscribe: (listener: Parameters<typeof fixture.api.subscribe>[0]) =>
      fixture.api.subscribe((envelope) => {
        if (envelope.event.type !== "bot.deleted") listener(envelope)
      }),
  }
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  openDeletion("settings")
  const dialog = screen.getByRole("dialog", { name: "Excluir bot" })

  fireEvent.change(within(dialog).getByLabelText("Digite o nome do bot: mark"), { target: { value: "mark" } })
  fireEvent.click(within(dialog).getByRole("button", { name: "Excluir bot" }))
  await act(async () => fixture.finishCleanup())

  await waitFor(() => expect(document.querySelector('[data-bot-entry="bot-mark"]')).toBeNull())
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(screen.getByText(/^O bot foi excluído, mas a limpeza/)).toBeVisible()
})

const openDeletion = (entry: "settings" | "sidebar"): void => {
  if (entry === "sidebar") {
    fireEvent.click(screen.getByRole("button", { name: "Ações de mark" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Excluir bot" }))
    return
  }

  showBotSettings()
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Avançado/ }))
  fireEvent.click(screen.getByRole("button", { name: "Excluir bot" }))
}
