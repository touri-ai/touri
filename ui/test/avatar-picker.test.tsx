import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { AvatarShape } from "@touri/contracts"
import { type AvatarIdentity, avatarProfileFor, LEGACY_AVATAR_SHAPES } from "@touri/contracts/avatar"
import { type ComponentProps, useState } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { type AvatarChoice, AvatarPicker } from "../src/components/AvatarPicker"
import { GroupModal } from "../src/components/GroupModal"
import { BotCreateModal, BotSettingsModal } from "../src/components/Modals"
import { type Locale, t } from "../src/i18n"
import type { WorkspaceActions } from "../src/useWorkspace"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it.each(["pt-BR", "en"] as const)("starts compact and localizes the two mascot actions in %s", (locale) => {
  const change = vi.fn()
  const { container } = render(<AvatarPicker bot={getBot()} locale={locale} onChange={change} />)

  expectCompactPicker(container, locale)
  expect(change).not.toHaveBeenCalled()
})

it.each(["pt-BR", "en"] as const)(
  "reveals and hides customization by keyboard without losing edits in %s",
  async (locale) => {
    const user = userEvent.setup()
    const change = vi.fn()
    const labels = getLabels(locale)
    const { container } = render(<Picker locale={locale} onChange={change} />)
    const customize = screen.getByRole("button", { name: t("avatar.customize", {}, locale) })
    customize.focus()

    await user.keyboard("{Enter}")

    expect(customize).toHaveAttribute("aria-expanded", "true")
    expect(document.getElementById(customize.getAttribute("aria-controls") ?? "")).toBeVisible()
    expect(screen.getByRole("radio", { name: labels.longHorns })).toBeChecked()
    expect(screen.getByRole("button", { name: t("avatar.reset", {}, locale) })).toBeVisible()

    await user.click(screen.getByRole("radio", { name: labels.shortHorns }))
    await user.click(screen.getByRole("radio", { name: labels.blue }))
    await user.click(customize)

    expectCompactPicker(container, locale)
    expect(change).toHaveBeenCalledTimes(2)
    expect(container.querySelector(".avatar-picker-stage .tb-avatar")).toHaveAttribute(
      "data-avatar-shape",
      "short-crown",
    )
    expect(container.querySelector(".avatar-picker-stage [data-avatar-body]")).toHaveAttribute("fill", "#3b93f0")

    await user.keyboard(" ")

    expect(customize).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByRole("radio", { name: labels.shortHorns })).toBeChecked()
    expect(screen.getByRole("radio", { name: labels.blue })).toBeChecked()
    expectNoStatePreview(container, locale)
    expect(change).toHaveBeenCalledTimes(2)
  },
)

it("propagates a complete randomized look while collapsed and restores automatic after disclosure", () => {
  const change = vi.fn()
  mockRandom(0.99)
  const bot = getBot()
  const automatic = avatarProfileFor({ id: bot.id, avatarSeed: bot.avatarSeed, color: null })
  const { container } = render(<Picker onChange={change} />)

  fireEvent.click(screen.getByRole("button", { name: "Sortear" }))

  expectCompactPicker(container)
  expect(change).toHaveBeenCalledExactlyOnceWith({ color: "#e152b0", avatarShape: "none-crown" })
  expect(container.querySelector(".avatar-picker-stage .tb-avatar")).toHaveAttribute("data-avatar-shape", "none-crown")
  expect(container.querySelector(".avatar-picker-stage [data-avatar-body]")).toHaveAttribute("fill", "#e152b0")

  fireEvent.click(screen.getByRole("button", { name: "Personalizar" }))
  fireEvent.click(screen.getByRole("button", { name: "Restaurar automático" }))

  expect(change).toHaveBeenLastCalledWith({ color: null, avatarShape: automatic.shape })
  expect(screen.getByRole("radio", { name: "Cor Automática" })).toBeChecked()
  expectNoStatePreview(container)
})

it("saves the fresh seeded mascot when creating a bot without opening customization", async () => {
  const seed = "00000000-0000-4000-8000-000000000577"
  mockSeed(seed)
  const profile = avatarProfileFor({ id: seed, color: null })
  const create = vi.fn().mockResolvedValue(undefined)
  render(<BotCreateModal onClose={vi.fn()} onCreate={create} />)

  expectCompactPicker(document.body)
  expect(document.querySelector(".avatar-picker-stage [data-avatar-body]")).toHaveAttribute("fill", profile.color)

  fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Seeded bot" } })
  fireEvent.click(screen.getByRole("button", { name: "Criar bot", exact: true }))

  await waitFor(() =>
    expect(create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ avatarSeed: seed, avatarShape: profile.shape, color: profile.color }),
    ),
  )
})

it("persists randomized bot choices through creation, settings, and reopening without state controls", async () => {
  const api = createMockApi()
  const random = mockRandom(0.99)
  const create = vi.fn<ComponentProps<typeof BotCreateModal>["onCreate"]>(async (input) => {
    await api.request("POST /bots", input)
  })
  const creation = render(<BotCreateModal onClose={vi.fn()} onCreate={create} />)

  expectCompactPicker(document.body)

  fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Randomized bot" } })
  fireEvent.click(screen.getByRole("button", { name: "Sortear" }))
  fireEvent.click(screen.getByRole("button", { name: "Criar bot", exact: true }))

  await waitFor(() =>
    expect(api.getState().bots.find((bot) => bot.name === "Randomized bot")).toMatchObject({
      avatarShape: "none-crown",
      color: "#e152b0",
    }),
  )
  const saved = api.getState().bots.find((bot) => bot.name === "Randomized bot")
  if (!saved) throw new Error("Missing created bot")
  expect(saved.avatarSeed).toBeTruthy()
  creation.unmount()
  const updateBot = vi.fn<WorkspaceActions["updateBot"]>(async (id, patch) => {
    await api.request("PATCH /bots/:id", patch, { id })
  })
  const actions = { updateBot } as WorkspaceActions
  const settings = render(
    <BotSettingsModal bot={saved} projects={[]} routines={[]} actions={actions} onClose={vi.fn()} />,
  )

  expectCompactPicker(document.body)
  expect(document.querySelector(".avatar-picker-stage [data-avatar-body]")).toHaveAttribute("fill", "#e152b0")

  random.setValue(0)
  fireEvent.click(screen.getByRole("button", { name: "Sortear" }))
  fireEvent.click(screen.getByRole("button", { name: "Salvar configurações" }))

  await waitFor(() =>
    expect(api.getState().bots.find((bot) => bot.id === saved.id)).toMatchObject({
      avatarShape: "classic-none",
      color: "#e8483f",
      avatarSeed: saved.avatarSeed,
    }),
  )
  const updated = api.getState().bots.find((bot) => bot.id === saved.id)
  if (!updated) throw new Error("Missing updated bot")
  settings.unmount()
  render(<BotSettingsModal bot={updated} projects={[]} routines={[]} actions={actions} onClose={vi.fn()} />)

  expectCompactPicker(document.body)
  expect(document.querySelector(".avatar-picker-stage .tb-avatar")).toHaveAttribute("data-avatar-shape", "classic-none")
  expect(document.querySelector(".avatar-picker-stage [data-avatar-body]")).toHaveAttribute("fill", "#e8483f")
})

it("persists a randomized group mascot and preserves it when saving the collapsed editor again", async () => {
  const api = createMockApi()
  mockRandom(0.99)
  const save = vi.fn<ComponentProps<typeof GroupModal>["onSave"]>(async (input) => {
    await api.request("POST /groups", input)
  })
  const creation = render(
    <GroupModal
      group={null}
      bots={api.getState().bots}
      initial={{ name: "Randomized team", memberIds: ["bot-mark"] }}
      onClose={vi.fn()}
      onSave={save}
    />,
  )

  expectCompactPicker(document.body)

  fireEvent.click(screen.getByRole("button", { name: "Sortear" }))
  const head = document.querySelector(".avatar-picker-stage [data-avatar-body]")?.getAttribute("d")
  fireEvent.click(screen.getByRole("button", { name: "Criar grupo", exact: true }))

  await waitFor(async () =>
    expect((await api.request("GET /groups")).groups.find((group) => group.name === "Randomized team")).toMatchObject({
      avatarShape: expect.stringMatching(/:none-crown$/),
      color: "#e152b0",
    }),
  )
  const group = (await api.request("GET /groups")).groups.find((group) => group.name === "Randomized team")
  if (!group) throw new Error("Missing created group")
  creation.unmount()
  const update = vi.fn().mockResolvedValue(undefined)
  render(<GroupModal group={group} bots={api.getState().bots} onClose={vi.fn()} onSave={update} />)

  expectCompactPicker(document.body)
  expect(document.querySelector(".avatar-picker-stage [data-avatar-body]")).toHaveAttribute("d", head)
  expect(document.querySelector(".avatar-picker-stage [data-avatar-body]")).toHaveAttribute("fill", group.color)

  fireEvent.click(screen.getByRole("button", { name: "Salvar grupo" }))

  await waitFor(() =>
    expect(update).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ avatarShape: group.avatarShape, color: group.color }),
    ),
  )
})

it("creates a group with its previewed default without opening customization", async () => {
  const seed = "00000000-0000-4000-8000-000000000578"
  mockSeed(seed)
  const save = vi.fn().mockResolvedValue(undefined)
  const api = createMockApi()
  const profile = avatarProfileFor({ id: seed, color: null })
  render(
    <GroupModal
      group={null}
      bots={api.getState().bots}
      initial={{ name: "Default team", memberIds: ["bot-mark"] }}
      onClose={vi.fn()}
      onSave={save}
    />,
  )

  expectCompactPicker(document.body)
  expect(document.querySelector(".avatar-picker-stage [data-avatar-body]")).toHaveAttribute("fill", profile.color)

  fireEvent.click(screen.getByRole("button", { name: "Criar grupo", exact: true }))

  await waitFor(() =>
    expect(save).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ avatarShape: `${profile.headShape}:${profile.shape}`, color: profile.color }),
    ),
  )
})

it.each<AvatarShape | null>(
  Array.of<AvatarShape | null>(null, "long-crown", "nuage:short-glasses").concat(LEGACY_AVATAR_SHAPES),
)("preserves the saved %s mascot when settings are saved without customization", async (avatarShape) => {
  const api = createMockApi()
  const original = api.getState().bots[0]
  if (!original) throw new Error("Missing fixture bot")
  const bot = Object.assign({}, original, { avatarShape, avatarSeed: null, color: null })
  const updateBot = vi.fn<WorkspaceActions["updateBot"]>().mockResolvedValue(undefined)
  const actions = { updateBot } as WorkspaceActions
  const settings = render(
    <BotSettingsModal bot={bot} projects={[]} routines={[]} actions={actions} onClose={vi.fn()} />,
  )
  const head = document.querySelector(".avatar-picker-stage [data-avatar-body]")?.getAttribute("d")

  expectCompactPicker(document.body)

  fireEvent.click(screen.getByRole("button", { name: "Personalizar" }))
  fireEvent.click(screen.getByRole("button", { name: "Personalizar" }))
  fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Renamed bot" } })
  fireEvent.click(screen.getByRole("button", { name: "Salvar configurações" }))

  await waitFor(() => expect(updateBot).toHaveBeenCalledOnce())
  const patch = updateBot.mock.calls[0]?.[1]
  expect(patch).toMatchObject({ name: "Renamed bot" })
  expect(patch).not.toHaveProperty("avatarShape")
  expect(patch).not.toHaveProperty("avatarSeed")
  expect(patch).not.toHaveProperty("color")
  settings.unmount()
  render(<BotSettingsModal bot={bot} projects={[]} routines={[]} actions={actions} onClose={vi.fn()} />)

  expectCompactPicker(document.body)
  expect(document.querySelector(".avatar-picker-stage [data-avatar-body]")).toHaveAttribute("d", head)
})

const getBot = (): AvatarIdentity => ({
  id: "compact-mascot",
  avatarSeed: "compact-mascot-seed",
  avatarShape: "long-crown",
  color: "#e8483f",
})

const Picker = ({
  locale = "pt-BR",
  onChange,
}: {
  locale?: Locale
  onChange: (choice: Partial<AvatarChoice>) => void
}) => {
  const [bot, setBot] = useState(getBot)

  return (
    <AvatarPicker
      bot={bot}
      locale={locale}
      onChange={(choice) => {
        setBot((current) => ({
          id: current.id,
          avatarSeed: current.avatarSeed,
          avatarShape: choice.avatarShape ?? current.avatarShape,
          color: choice.color === undefined ? current.color : choice.color,
        }))
        onChange(choice)
      }}
    />
  )
}

const getLabels = (locale: Locale) => ({
  longHorns: t("avatar.horns.choice", { horns: t("avatar.horns.long", {}, locale) }, locale),
  shortHorns: t("avatar.horns.choice", { horns: t("avatar.horns.short", {}, locale) }, locale),
  blue: t("Avatar color", { color: t("Blue", {}, locale) }, locale),
})

const expectCompactPicker = (container: HTMLElement, locale: Locale = "pt-BR") => {
  const picker = container.querySelector(".avatar-picker")
  if (!(picker instanceof HTMLElement)) throw new Error("Missing mascot editor")
  const queries = within(picker)

  expect(queries.getAllByRole("button")).toHaveLength(2)
  expect(queries.getByRole("button", { name: t("avatar.shuffle", {}, locale) })).toBeVisible()
  expect(queries.getByRole("button", { name: t("avatar.customize", {}, locale) })).toHaveAttribute(
    "aria-expanded",
    "false",
  )
  expect(queries.queryByRole("button", { name: t("avatar.reset", {}, locale) })).not.toBeInTheDocument()
  expect(picker.querySelectorAll("input")).toHaveLength(0)
  expect(picker.querySelectorAll(".tb-avatar")).toHaveLength(1)
  expectNoStatePreview(picker, locale)
}

const expectNoStatePreview = (container: HTMLElement, locale: Locale = "pt-BR") => {
  const queries = within(container)

  expect(queries.queryByRole("group", { name: t("avatar.preview", {}, locale) })).not.toBeInTheDocument()
  expect(container.querySelector(".avatar-picker-moods")).not.toBeInTheDocument()
  const states = [
    "avatar.preview.idle",
    "avatar.preview.thinking",
    "avatar.preview.working",
    "avatar.preview.waiting",
    "avatar.preview.done",
    "avatar.preview.failed",
    "avatar.preview.asleep",
  ] as const
  states.forEach((state) => {
    const name = t(state, {}, locale)

    expect(queries.queryByRole("radio", { name, exact: true })).not.toBeInTheDocument()
    expect(queries.queryByRole("button", { name, exact: true })).not.toBeInTheDocument()
  })
}

const mockRandom = (value: number) => {
  const random = vi.spyOn(Math, "random").mockReturnValue(value)

  return {
    setValue: (next: number) => random.mockReturnValue(next),
    restore: () => random.mockRestore(),
  }
}

const mockSeed = (seed: ReturnType<Crypto["randomUUID"]>) => {
  const randomUUID = vi.spyOn(crypto, "randomUUID").mockReturnValue(seed)

  return () => randomUUID.mockRestore()
}
