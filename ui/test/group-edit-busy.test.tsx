import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { expect, test, vi } from "vitest"
import { createApiClient } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { GroupModal } from "../src/components/GroupModal"
import { ApiError } from "../src/errors"
import { t } from "../src/i18n"

test("a busy removal names the actual working bot and preserves the pending edits for retry", async () => {
  const bots = createMockApi().getState().bots.slice(0, 2)
  const [first, busy] = bots
  if (!first || !busy) throw new Error("Missing members")
  const onSave = vi
    .fn()
    .mockRejectedValueOnce(
      new ApiError(409, "private diagnostic", "GROUP_MEMBER_BUSY", "TOURI-E1005", undefined, undefined, busy.id),
    )
    .mockResolvedValueOnce(undefined)
  const onClose = vi.fn()
  render(
    <GroupModal
      group={{
        id: "team",
        name: "Equipe",
        color: "#dc2626",
        avatarShape: "classic-none",
        avatarSeed: "team",
        memberIds: bots.map((bot) => bot.id),
        coordinatorBotId: null,
        createdAt: 1,
        updatedAt: 1,
      }}
      bots={bots}
      channelMode
      onSave={onSave}
      onClose={onClose}
    />,
  )
  fireEvent.change(screen.getByRole("textbox", { name: "Nome do canal" }), { target: { value: "Equipe ampliada" } })
  fireEvent.click(screen.getByRole("checkbox", { name: busy.name, exact: true }))

  fireEvent.click(screen.getByRole("button", { name: "Salvar canal" }))

  expect(await screen.findByRole("alert")).toHaveTextContent(`${busy.name} está trabalhando; remova quando terminar.`)
  expect(screen.getByRole("alert")).not.toHaveTextContent("private diagnostic")
  expect(onClose).not.toHaveBeenCalled()
  expect(screen.getByRole("textbox", { name: "Nome do canal" })).toHaveValue("Equipe ampliada")

  fireEvent.click(screen.getByRole("button", { name: "Salvar canal" }))

  await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ name: "Equipe ampliada", memberIds: [first.id] }))
})

test("busy member guidance is available in Portuguese and English", () => {
  const key = "{bot} is working; remove them when they finish."

  expect(t(key, { bot: "Lia" }, "pt-BR")).toBe("Lia está trabalhando; remova quando terminar.")
  expect(t(key, { bot: "Lia" }, "en")).toBe("Lia is working; remove them when they finish.")
})

test("the HTTP client retains the busy member identity alongside its registered conflict", async () => {
  const api = createApiClient({
    endpoint: { baseUrl: "http://localhost", wsUrl: "ws://localhost/events", token: "synthetic" },
    fetchImpl: async () =>
      Response.json(
        { errorCode: "GROUP_MEMBER_BUSY", code: "TOURI-E1005", busyBotId: "bot-qa", error: "private diagnostic" },
        { status: 409 },
      ),
  })

  const request = api.request(
    "PATCH /groups/:id",
    { name: "Equipe", color: "#dc2626", avatarShape: "classic-none", memberIds: ["other"], coordinatorBotId: null },
    { id: "team" },
  )

  await expect(request).rejects.toMatchObject({
    status: 409,
    errorCode: "GROUP_MEMBER_BUSY",
    busyBotId: "bot-qa",
    code: "TOURI-E1005",
  })
})
