import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ApiRoutes, Bot } from "@touri/contracts"
import { createRef } from "react"
import { afterEach, expect, it, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { Composer } from "../src/components/Composer"
import { BotSettingsModal } from "../src/components/Modals"
import { ModelPicker } from "../src/components/ModelPicker"
import { t } from "../src/i18n"
import type { WorkspaceActions } from "../src/useWorkspace"

afterEach(cleanup)

const getBot = (changes: Partial<Bot> = {}): Bot => {
  const bot = createMockApi().getState().bots[0]
  if (!bot) throw new Error("Missing fixture bot")

  return { ...bot, ...changes }
}

const openSettings = (
  bot: Bot,
  api = createMockApi(),
  saveModel: WorkspaceActions["updateBotModel"] = async () => {},
) => {
  const updateBot = vi.fn<WorkspaceActions["updateBot"]>(async () => {})
  const updateBotModel = vi.fn(saveModel)
  const onClose = vi.fn()
  render(
    <BotSettingsModal
      api={api}
      bot={bot}
      projects={[]}
      routines={[]}
      initialSection="model"
      actions={{ updateBot, updateBotModel } as WorkspaceActions}
      onClose={onClose}
    />,
  )

  return { updateBot, updateBotModel, onClose }
}

it.each(["cancel", "save"])("keeps a changed provider's model in the form until confirmation: %s", async (action) => {
  const bot = getBot({ provider: "claude", model: "sonnet" })
  const { updateBot, updateBotModel, onClose } = openSettings(bot)

  fireEvent.change(screen.getByLabelText("Provedor"), { target: { value: "codex" } })
  fireEvent.click(screen.getByRole("button", { name: /^Escolher modelo:/ }))
  fireEvent.click(screen.getByRole("option", { name: "gpt-6.1-sol" }))
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())

  expect(updateBotModel).not.toHaveBeenCalled()
  expect(updateBot).not.toHaveBeenCalled()
  expect(bot).toMatchObject({ provider: "claude", model: "sonnet" })
  if (action === "cancel") {
    fireEvent.click(screen.getByRole("button", { name: "Cancelar", exact: true }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(updateBot).not.toHaveBeenCalled()
    return
  }

  fireEvent.click(screen.getByRole("button", { name: "Salvar configurações" }))

  await waitFor(() =>
    expect(updateBot).toHaveBeenCalledWith(
      bot.id,
      expect.objectContaining({ provider: "codex", model: "gpt-6.1-sol" }),
    ),
  )
})

it.each(["touri-api-new/demo-model", ""])("saves a changed API model without changing provider: %j", async (model) => {
  const api = createMockApi()
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /api-models") {
      return {
        models: [{ id: "new", preset: "custom", name: "Demo", modelId: "demo-model", baseUrl: "https://example.com" }],
      } as never
    }
    return api.request(route, input, path)
  }
  const bot = getBot({ provider: "opencode", model: "touri-api-old/old-model" })
  const { updateBot, updateBotModel } = openSettings(bot, { ...api, request })
  const picker = await screen.findByRole("combobox", { name: "Modelos por API" })
  await within(picker).findByRole("option", { name: "Demo · demo-model" })

  fireEvent.change(picker, { target: { value: model } })
  fireEvent.click(screen.getByRole("button", { name: "Salvar configurações" }))

  await waitFor(() =>
    expect(updateBot).toHaveBeenCalledWith(
      bot.id,
      expect.objectContaining({ provider: "opencode", model: model || null }),
    ),
  )
  expect(updateBotModel).not.toHaveBeenCalled()
})

const getDeferred = <T,>() => {
  // Promise callbacks capture the resolver locally so responses can arrive out of order.
  const resolvers: { resolve?: (value: T) => void } = {}
  const promise = new Promise<T>((resolve) => Object.assign(resolvers, { resolve }))

  return { promise, resolve: (value: T) => resolvers.resolve?.(value) }
}

const getDiscovery = () => {
  const api = createMockApi()
  const first = getDeferred<ApiRoutes["GET /providers/opencode/models"]["res"]>()
  const second = getDeferred<ApiRoutes["GET /providers/opencode/models"]["res"]>()
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /providers/opencode/models") {
      return (await (input.botId === "first" ? first.promise : second.promise)) as never
    }
    if (route === "GET /api-models") return { models: [] } as never
    return api.request(route, input, path)
  }

  return { api: { ...api, request }, first, second }
}

it("ignores late discovery after the picker changes bots", async () => {
  const { api, first, second } = getDiscovery()
  const onSave = vi.fn(async () => {})
  const props = { api, provider: "opencode" as const, value: null, onSave, onNotice: vi.fn() }
  const view = render(<ModelPicker {...props} botId="first" />)
  fireEvent.click(screen.getByRole("button", { name: /^Escolher modelo:/ }))

  view.rerender(<ModelPicker {...props} botId="second" />)
  await act(async () => second.resolve({ models: ["demo/current"], defaultModel: "demo/current", available: true }))
  await screen.findByRole("option", { name: "demo/current" })
  await act(async () => first.resolve({ models: ["demo/stale"], defaultModel: "demo/stale", available: true }))

  expect(screen.queryByRole("option", { name: "demo/stale" })).toBeNull()
  expect(screen.getByRole("option", { name: "demo/current" })).toBeVisible()
  expect(screen.getByRole("option", { name: "Padrão do provedor · demo/current" })).toBeVisible()
  fireEvent.click(screen.getByRole("option", { name: "demo/current" }))

  await waitFor(() => expect(onSave).toHaveBeenCalledExactlyOnceWith("demo/current"))
})

it("closes the composer picker on bot switch and keeps the next bot's catalog", async () => {
  const { api, first, second } = getDiscovery()
  const bot = getBot({ id: "first", provider: "opencode", model: null })
  const props = {
    api,
    threadId: bot.mainThreadId ?? "demo-thread",
    parentId: null,
    draft: "",
    onDraft: vi.fn(),
    inputRef: createRef<HTMLTextAreaElement>(),
    activeRun: null,
    queuedCount: 0,
    onSend: vi.fn(async () => {}),
    onCancel: vi.fn(async () => {}),
    onSaveModel: vi.fn(async () => {}),
    onNotice: vi.fn(),
  }
  const view = render(<Composer {...props} bot={bot} />)
  fireEvent.click(screen.getByRole("button", { name: /^Escolher modelo:/ }))
  expect(screen.getByRole("listbox")).toBeVisible()

  view.rerender(<Composer {...props} bot={{ ...bot, id: "second" }} />)

  expect(screen.queryByRole("listbox")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: /^Escolher modelo:/ }))
  await act(async () => second.resolve({ models: ["demo/current"], defaultModel: null, available: true }))
  await act(async () => first.resolve({ models: ["demo/stale"], defaultModel: null, available: true }))

  expect(screen.queryByRole("option", { name: "demo/stale" })).toBeNull()
  fireEvent.click(screen.getByRole("option", { name: "demo/current" }))

  await waitFor(() => expect(props.onSaveModel).toHaveBeenCalledExactlyOnceWith("demo/current"))
})

it.each(["--help", " -config ", "demo\u034fmodel", "demo\ufe0fmodel", "m".repeat(257)])(
  "rejects unsafe custom model input before saving: %j",
  async (model) => {
    const onSave = vi.fn(async () => {})
    render(<ModelPicker provider="codex" value={null} onSave={onSave} onNotice={vi.fn()} />)

    fireEvent.click(screen.getByRole("button", { name: /^Escolher modelo:/ }))
    fireEvent.click(screen.getByRole("option", { name: "Outro modelo…" }))
    const input = screen.getByRole("textbox", { name: "Nome do modelo" })
    fireEvent.change(input, { target: { value: model } })
    fireEvent.keyDown(input, { key: "Enter" })

    expect(screen.getByRole("alert")).toHaveTextContent("até 256 caracteres")
    expect(onSave).not.toHaveBeenCalled()
  },
)

it("explains model validation in Portuguese and English", () => {
  const message = "Use a model name of up to 256 characters, without hidden or control characters or a leading dash."

  expect(t(message, {}, "pt-BR")).toContain("sem hífen no início")
  expect(t(message, {}, "en")).toBe(message)
})

it("keeps provider selectors locked until an immediate model save settles", async () => {
  const api = createMockApi()
  await api.request("POST /api-models", {
    preset: "custom",
    baseUrl: "https://example.com/v1",
    apiKey: "fixture-model-key",
    name: "Demo API",
    modelId: "demo-model",
  })
  const pending = getDeferred<void>()
  const bot = getBot({ provider: "codex", model: "gpt-6.1-sol" })
  openSettings(bot, api, () => pending.promise)
  await screen.findByRole("combobox", { name: "Modelos por API" })

  fireEvent.click(screen.getByRole("button", { name: /^Escolher modelo:/ }))
  fireEvent.click(screen.getByRole("option", { name: "gpt-6-luna" }))

  expect(screen.getByRole("combobox", { name: "Provedor", exact: true })).toBeDisabled()
  expect(screen.getByRole("combobox", { name: "Modelos por API" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Salvar configurações" })).toBeDisabled()

  await act(async () => pending.resolve())

  expect(screen.getByRole("combobox", { name: "Provedor", exact: true })).toBeEnabled()
  expect(screen.getByRole("combobox", { name: "Modelos por API" })).toBeEnabled()
  expect(screen.getByRole("button", { name: "Salvar configurações" })).toBeEnabled()
})

it("preserves a newer stored model when saving an unrelated settings change", async () => {
  const api = createMockApi()
  const bot = getBot({ provider: "claude", model: "sonnet" })
  const updateBot = vi.fn<WorkspaceActions["updateBot"]>(async () => {})
  const props = {
    api,
    projects: [],
    routines: [],
    actions: { updateBot } as WorkspaceActions,
    onClose: vi.fn(),
  }
  const view = render(<BotSettingsModal {...props} bot={bot} />)

  view.rerender(<BotSettingsModal {...props} bot={{ ...bot, model: "haiku" }} />)
  fireEvent.change(screen.getByRole("textbox", { name: "Nome", exact: true }), { target: { value: "Demo Renamed" } })
  fireEvent.click(screen.getByRole("button", { name: "Salvar configurações" }))

  await waitFor(() => expect(updateBot).toHaveBeenCalledOnce())
  expect(updateBot.mock.calls[0]?.[1]).not.toHaveProperty("model")
})
