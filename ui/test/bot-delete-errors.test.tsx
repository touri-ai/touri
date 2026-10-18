import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test } from "vitest"
import { createMockApi } from "../src/api/mock"
import { DeleteBotDialog } from "../src/components/DeleteBotDialog"
import { ApiError } from "../src/errors"
import { t } from "../src/i18n"

afterEach(cleanup)

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
