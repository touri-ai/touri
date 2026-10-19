import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { BotGroup } from "@touri/contracts"
import { avatarColorFor, avatarShapeFor } from "@touri/contracts/avatar"
import { afterEach, expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { GroupModal } from "../src/components/Groups"

const getGroup = (): BotGroup => ({
  id: "group-avatar",
  name: "Equipe",
  color: "#123456",
  avatarShape: "long-crown",
  avatarSeed: "group-avatar-seed",
  memberIds: ["bot-mark"],
  coordinatorBotId: null,
  createdAt: 1,
  updatedAt: 1,
})

afterEach(() => vi.restoreAllMocks())

it.each([
  { role: "radio", name: "Cor Automática", resetsShape: false },
  { role: "button", name: "Restaurar automático", resetsShape: true },
])("restores a saved group's seeded colour through $name", async ({ role, name, resetsShape }) => {
  const group = getGroup()
  const bots = createMockApi().getState().bots
  const onSave = vi.fn().mockResolvedValue(undefined)
  const { container } = render(<GroupModal group={group} bots={bots} onClose={vi.fn()} onSave={onSave} />)
  const color = avatarColorFor({ id: group.avatarSeed, color: null })

  fireEvent.click(screen.getByRole(role, { name }))

  expect(screen.getByRole("radio", { name: "Cor Automática" })).toBeChecked()
  expect(container.querySelector("[data-avatar-body]")).toHaveAttribute("fill", color)

  fireEvent.click(screen.getByRole("button", { name: "Salvar grupo" }))

  await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
  expect(onSave).toHaveBeenCalledWith({
    name: group.name,
    color,
    avatarShape: resetsShape ? avatarShapeFor(group.avatarSeed) : group.avatarShape,
    memberIds: ["bot-mark"],
    coordinatorBotId: null,
  })
})

it("restores a new group's own seeded colour before saving", async () => {
  const seed = "00000000-0000-4000-8000-000000000001"
  vi.spyOn(crypto, "randomUUID").mockReturnValue(seed)
  const onSave = vi.fn().mockResolvedValue(undefined)
  const bots = createMockApi().getState().bots
  const { container } = render(
    <GroupModal
      group={null}
      initial={{ name: "Equipe", memberIds: ["bot-mark"] }}
      bots={bots}
      onClose={vi.fn()}
      onSave={onSave}
    />,
  )
  fireEvent.click(screen.getByRole("radio", { name: "Cor Azul" }))

  fireEvent.click(screen.getByRole("radio", { name: "Cor Automática" }))

  expect(screen.getByRole("radio", { name: "Cor Automática" })).toBeChecked()
  expect(container.querySelector("[data-avatar-body]")).toHaveAttribute(
    "fill",
    avatarColorFor({ id: seed, color: null }),
  )

  fireEvent.click(screen.getByRole("button", { name: "Criar grupo" }))

  await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
  expect(onSave).toHaveBeenCalledWith({
    name: "Equipe",
    color: avatarColorFor({ id: seed, color: null }),
    avatarShape: avatarShapeFor(seed),
    memberIds: ["bot-mark"],
    coordinatorBotId: null,
  })
})
