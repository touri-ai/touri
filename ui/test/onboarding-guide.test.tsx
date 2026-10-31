import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { UiEventEnvelope } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import type { TauriInvoke, UiApi } from "../src/api/client"
import { ApiError } from "../src/errors"
import { GuidedOnboarding } from "../src/features/onboarding/GuidedOnboarding"
import { TeamFields } from "../src/features/onboarding/GuideFields"
import { getImportProgress, getIsEmptyOwnerWorkspace, getWebsite } from "../src/features/onboarding/guide"
import { dictionaries } from "../src/i18n"
import { readWorkspaceState } from "../src/workspaceState"
import {
  getGuideBotFixture,
  getGuideGroupFixture,
  getGuidePreviewFixture,
  getGuideSourceFixture,
  getGuideThreadFixture,
} from "./fixtures/onboarding-guide"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  localStorage.clear()
})

const getFixture = (overrides: Record<string, unknown> = {}) => {
  const listeners = new Set<(event: UiEventEnvelope) => void>()
  const request = vi.fn(async (route: string, input: Record<string, unknown>, paths?: { id?: string }) => {
    if (overrides[route] instanceof Error) throw overrides[route]
    const override = overrides[route]
    if (typeof override === "function") return override()
    if (route in overrides) return override
    if (route === "GET /api/v1/import/sources") return { sources: [getGuideSourceFixture()] }
    if (route === "POST /api/v1/import/preview") return getGuidePreviewFixture()
    if (route === "POST /api/v1/import/apply")
      return { importId: "import-one", bots: [{ agentKey: "dev", botId: "bot-dev" }], pausedRoutines: 1, reconnect: [] }
    if (route === "GET /bots") return { bots: [getGuideBotFixture(), getGuideBotFixture("dev")] }
    if (route === "GET /groups") return { groups: [] }
    if (route === "POST /groups") return { group: getGuideGroupFixture(), thread: getGuideThreadFixture() }
    if (route === "GET /groups/:id/threads") return { threads: [getGuideThreadFixture()] }
    if (route === "PATCH /bots/:id") {
      const bot = paths?.id === "bot-dev" ? getGuideBotFixture("dev") : getGuideBotFixture()
      return { bot: { ...bot, ...input } }
    }
    if (route === "GET /bots/:id/provider-login/flow")
      return { provider: input.provider, state: "ready", executable: "available" }
    if (route === "GET /public-address") return { address: "https://team.example.com", reachability: "public" }
    return {}
  }) as UiApi["request"]
  const api: UiApi = {
    request,
    isMock: false,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  const complete = vi.fn(async () => undefined)
  const invoke = vi.fn(async () => null) as TauriInvoke
  const view = render(<GuidedOnboarding api={api} invoke={invoke} onBack={vi.fn()} onComplete={complete} />)
  return { request, complete, listeners, view }
}
const continueSetup = () => fireEvent.click(screen.getByRole("button", { name: /^Continuar/ }))
const enterWorkspace = () => {
  fireEvent.change(screen.getByRole("textbox", { name: "Nome" }), { target: { value: "Equipe exemplo" } })
  continueSetup()
}
it("keeps the owner's answer and highlights the live workspace without a step rail", () => {
  const { view } = getFixture()

  enterWorkspace()

  expect(screen.getByRole("heading", { name: "O que Equipe exemplo faz?" })).toBeVisible()
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2")
  expect(within(screen.getByLabelText("Suas respostas")).getByText("Equipe exemplo")).toBeVisible()
  expect(view.container.querySelector('.ob-preview-section[data-highlighted="true"] h2')).toHaveTextContent("Canais")
  expect(screen.queryByRole("navigation")).toBeNull()
})
it("preserves field focus when the owner starts typing before the scheduled heading focus", async () => {
  vi.useFakeTimers()
  getFixture()
  enterWorkspace()
  const context = screen.getByRole("textbox", { name: "Conte sobre seu trabalho" })

  context.focus()
  await act(async () => vi.advanceTimersByTime(100))

  expect(context).toHaveFocus()
})
it("handles Escape before a question receives its scheduled focus", () => {
  vi.useFakeTimers()
  getFixture()
  enterWorkspace()

  fireEvent.keyDown(document.body, { key: "Escape" })

  expect(screen.getByRole("textbox", { name: "Nome", exact: true })).toHaveValue("Equipe exemplo")
})
it("does not leave an open dialog when Escape reaches the body", () => {
  getFixture()
  enterWorkspace()
  render(<section role="dialog" aria-label="Diálogo de exemplo" />)

  fireEvent.keyDown(document.body, { key: "Escape" })

  expect(screen.getByRole("heading", { name: "O que Equipe exemplo faz?" })).toBeVisible()
})
it("preselects discovered sources and sends only reviewed item selections to apply", async () => {
  const { request } = getFixture()
  enterWorkspace()
  continueSetup()
  const source = await screen.findByRole("button", { name: /Claude Code/ })
  expect(source).toHaveAttribute("aria-pressed", "true")

  continueSetup()
  await screen.findByRole("heading", { name: "Confere o que vem?" })
  fireEvent.click(screen.getByRole("checkbox", { name: /Memórias/ }))
  fireEvent.click(screen.getByRole("button", { name: /Importar selecionados/ }))

  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("POST /api/v1/import/apply", {
      previewId: "preview-one",
      select: { dev: { instructions: true, skills: true, memories: false, routines: true } },
    }),
  )
  expect(screen.getByText("Rotinas pausadas")).toBeVisible()
  expect(within(screen.getByRole("complementary")).getByText("revisao-diaria · Rotinas pausadas")).toBeVisible()
})
it("returns from sources to the previous context without losing answers", async () => {
  getFixture()
  enterWorkspace()
  const context = "Criamos ferramentas para equipes."
  fireEvent.change(screen.getByRole("textbox", { name: "Conte sobre seu trabalho" }), { target: { value: context } })
  continueSetup()
  await screen.findByRole("button", { name: /Claude Code/ })

  fireEvent.keyDown(screen.getByRole("main"), { key: "Escape" })

  expect(screen.getByRole("textbox", { name: "Conte sobre seu trabalho" })).toHaveValue(context)
})
it("keeps identical agent keys from separate sources scoped to their own import", async () => {
  const first = getGuidePreviewFixture()
  const agent = first.agents[0]
  if (!agent) throw new Error("Missing synthetic preview agent")
  const second = { ...first, previewId: "preview-two", agents: [{ ...agent, suggestedBotName: "ops" }] }
  const pending = Promise.withResolvers<unknown>()
  const preview = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
  const apply = vi
    .fn()
    .mockResolvedValueOnce({
      importId: "import-one",
      bots: [{ agentKey: "dev", botId: "bot-dev" }],
      pausedRoutines: 1,
      reconnect: [],
    })
    .mockReturnValueOnce(pending.promise)
  const source = getGuideSourceFixture()
  const { view } = getFixture({
    "GET /api/v1/import/sources": { sources: [source, { ...source, id: "second-source", kind: "folder" }] },
    "POST /api/v1/import/preview": preview,
    "POST /api/v1/import/apply": apply,
  })
  enterWorkspace()
  continueSetup()
  await screen.findByRole("button", { name: /Claude Code/ })
  continueSetup()
  await screen.findByRole("heading", { name: "Confere o que vem?" })

  fireEvent.click(screen.getByRole("button", { name: /Importar selecionados/ }))
  await waitFor(() => expect(apply).toHaveBeenCalledTimes(2))

  const rows = view.container.querySelectorAll(".ob-import-agent")
  expect(rows[0]).toHaveTextContent("Pronto")
  expect(rows[1]).toHaveTextContent("Copiando")
  expect(rows[1]).not.toHaveTextContent("Pronto")
  await act(async () =>
    pending.resolve({
      importId: "import-two",
      bots: [{ agentKey: "dev", botId: "bot-ops" }],
      pausedRoutines: 1,
      reconnect: [],
    }),
  )
  expect(rows[1]).toHaveTextContent("Pronto")
})
it("omits unchecked agents from the apply map", async () => {
  const preview = getGuidePreviewFixture()
  const first = preview.agents[0]
  if (!first) throw new Error("Missing synthetic preview agent")
  const { request } = getFixture({
    "POST /api/v1/import/preview": {
      ...preview,
      agents: [first, { ...first, key: "skip", name: "skip", suggestedBotName: "skip" }],
    },
  })
  enterWorkspace()
  continueSetup()
  await screen.findByRole("button", { name: /Claude Code/ })
  continueSetup()
  await screen.findByRole("heading", { name: "Confere o que vem?" })

  fireEvent.click(screen.getByRole("checkbox", { name: "Incluir skip", exact: true }))
  fireEvent.click(screen.getByRole("button", { name: /Importar selecionados/ }))

  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("POST /api/v1/import/apply", {
      previewId: "preview-one",
      select: { dev: { instructions: true, skills: true, memories: true, routines: true } },
    }),
  )
})
it("leaves clipboard denial recoverable and never stores the pasted export in browser storage", async () => {
  getFixture()
  enterWorkspace()
  continueSetup()
  fireEvent.click(await screen.findByRole("button", { name: /Outro app \(pedido de exportação\)/ }))

  fireEvent.click(screen.getByRole("button", { name: "Colar resposta" }))

  await screen.findByText("Cole a resposta no campo abaixo.")
  fireEvent.change(screen.getByRole("textbox", { name: "Resposta em JSON" }), { target: { value: "invalid" } })
  continueSetup()
  await screen.findByRole("alert")
  expect(screen.getByRole("textbox", { name: "Resposta em JSON" })).toHaveValue("invalid")
  expect(localStorage.length).toBe(0)
})
it("keeps access opt-in and sends the first task to the general channel with a retry nonce", async () => {
  const { request, complete } = getFixture()
  enterWorkspace()
  continueSetup()
  fireEvent.click(await screen.findByRole("button", { name: "Pular" }))
  const browser = screen.getByRole("checkbox", { name: /Navegador/ })
  expect(browser).not.toBeChecked()
  expect(screen.getByRole("checkbox", { name: /Comandos sem aprovação/ })).not.toBeChecked()

  continueSetup()
  await screen.findByRole("heading", { name: "Seu time de agentes" })
  continueSetup()
  await screen.findByRole("heading", { name: "Quem mais trabalha com você?" })
  fireEvent.click(screen.getByRole("button", { name: "Pular" }))
  fireEvent.change(screen.getByRole("textbox", { name: "Sua primeira tarefa" }), {
    target: { value: "Organize as prioridades." },
  })
  fireEvent.click(screen.getByRole("button", { name: /Enviar primeira tarefa/ }))

  await screen.findByRole("heading", { name: "Seu touri está pronto" })
  expect(request).toHaveBeenCalledWith(
    "POST /threads/:id/messages",
    expect.objectContaining({
      text: expect.stringContaining("@touri Organize as prioridades.\n\nWorkspace: Equipe exemplo."),
      clientNonce: expect.any(String),
    }),
    { id: "general-thread" },
  )
  await waitFor(() => expect(complete).toHaveBeenCalledOnce())
  expect(readWorkspaceState()).toMatchObject({ threadId: "general-thread", teamSuggestionDismissed: true })
  expect(localStorage.getItem("touri.sidebar.mode")).toBe("work")
})
it("keeps Enter inside account settings and refreshes API models when the editor closes", async () => {
  const catalog = vi.fn().mockReturnValue({ models: [], executorAvailable: true })
  getFixture({ "GET /api-models": catalog })
  enterWorkspace()
  continueSetup()
  fireEvent.click(await screen.findByRole("button", { name: "Pular" }))
  continueSetup()
  await screen.findByRole("heading", { name: "Seu time de agentes" })
  fireEvent.change(screen.getByRole("combobox", { name: "Conta de IA" }), { target: { value: "opencode" } })
  fireEvent.click(screen.getByRole("button", { name: "Chave de API" }))
  const key = await screen.findByLabelText("Chave de API")
  fireEvent.change(key, { target: { value: "synthetic-key" } })

  fireEvent.keyDown(key, { key: "Enter" })

  expect(screen.getByRole("heading", { name: "Seu time de agentes" })).toBeVisible()
  expect(key).toHaveValue("synthetic-key")
  catalog.mockReturnValue({
    models: [
      {
        id: "example",
        preset: "custom",
        name: "Modelo exemplo",
        baseUrl: "https://api.example.com",
        modelId: "model-x",
      },
    ],
    executorAvailable: true,
  })
  fireEvent.click(screen.getByRole("button", { name: "Fechar", exact: true }))
  await screen.findByRole("option", { name: "Modelo exemplo · model-x" })
})
it("removes preview-only agents when the owner skips review", async () => {
  getFixture()
  enterWorkspace()
  continueSetup()
  await screen.findByRole("button", { name: /Claude Code/ })
  continueSetup()
  await screen.findByRole("heading", { name: "Confere o que vem?" })

  fireEvent.click(screen.getByRole("button", { name: "Pular" }))

  expect(screen.getByRole("heading", { name: "O que seus agentes podem usar?" })).toBeVisible()
  expect(within(screen.getByRole("complementary")).queryByText("dev")).toBeNull()
})
it("validates a typed website before continuing", () => {
  getFixture()
  enterWorkspace()
  const website = screen.getByRole("textbox", { name: "Site (opcional)" })
  fireEvent.change(website, { target: { value: "file:///workspace/site" } })

  continueSetup()

  expect(screen.getByRole("alert")).toHaveTextContent("Use um endereço HTTPS")
  expect(screen.getByRole("heading", { name: "O que Equipe exemplo faz?" })).toBeVisible()
})
it("suggests only routines the owner chose to import", async () => {
  getFixture({
    "POST /api/v1/import/apply": {
      importId: "import-one",
      bots: [{ agentKey: "dev", botId: "bot-dev" }],
      pausedRoutines: 0,
      reconnect: [],
    },
  })
  enterWorkspace()
  continueSetup()
  await screen.findByRole("button", { name: /Claude Code/ })
  continueSetup()
  await screen.findByRole("heading", { name: "Confere o que vem?" })
  fireEvent.click(screen.getByRole("checkbox", { name: /Rotinas/ }))
  fireEvent.click(screen.getByRole("button", { name: /Importar selecionados/ }))
  await screen.findByText("Pronto", { exact: true })
  continueSetup()
  continueSetup()
  await screen.findByRole("heading", { name: "Seu time de agentes" })
  continueSetup()
  await screen.findByRole("heading", { name: "Quem mais trabalha com você?" })

  fireEvent.click(screen.getByRole("button", { name: "Pular" }))

  expect(screen.getByRole("heading", { name: "O que eles fazem primeiro?" })).toBeVisible()
  expect(screen.queryByRole("button", { name: /Revise a rotina/ })).toBeNull()
})
it("returns an expired import preview to source review", async () => {
  getFixture({ "POST /api/v1/import/apply": new ApiError(410, "IMPORT_PREVIEW_EXPIRED") })
  enterWorkspace()
  continueSetup()
  await screen.findByRole("button", { name: /Claude Code/ })
  continueSetup()
  await screen.findByRole("heading", { name: "Confere o que vem?" })
  fireEvent.click(screen.getByRole("button", { name: /Importar selecionados/ }))
  await screen.findByRole("alert")
  expect(screen.getByText("Cópia interrompida")).toBeVisible()

  fireEvent.click(screen.getByRole("button", { name: "Revisar fontes", exact: true }))

  expect(screen.getByRole("heading", { name: "Já usa agentes em outro app?" })).toBeVisible()
  expect(screen.queryByRole("alert")).toBeNull()
})
it("preserves instructions of an imported agent named touri", async () => {
  const bot = { ...getGuideBotFixture(), instructions: "Preserve minhas instruções." }
  const preview = getGuidePreviewFixture()
  const { request } = getFixture({
    "GET /bots": { bots: [bot] },
    "POST /api/v1/import/preview": {
      ...preview,
      agents: preview.agents.map((agent) => ({ ...agent, key: "touri", name: "touri", suggestedBotName: "touri" })),
    },
    "POST /api/v1/import/apply": {
      importId: "one",
      bots: [{ agentKey: "touri", botId: bot.id }],
      pausedRoutines: 0,
      reconnect: [],
    },
  })
  enterWorkspace()
  continueSetup()
  await screen.findByRole("button", { name: /Claude Code/ })
  continueSetup()
  await screen.findByRole("heading", { name: "Confere o que vem?" })
  fireEvent.click(screen.getByRole("button", { name: /Importar selecionados/ }))
  await screen.findByText("Pronto", { exact: true })
  continueSetup()
  continueSetup()
  await screen.findByRole("heading", { name: "Seu time de agentes" })

  continueSetup()

  await screen.findByRole("heading", { name: "Quem mais trabalha com você?" })
  const update = vi.mocked(request).mock.calls.find(([route]) => route === "PATCH /bots/:id")
  expect(update?.[1]).not.toHaveProperty("instructions")
  expect(update?.[1]).not.toHaveProperty("description")
  expect(request).not.toHaveBeenCalledWith("POST /bots", expect.anything())
})
it("reserves a place for the guide within the channel member limit", async () => {
  const preview = getGuidePreviewFixture()
  const template = preview.agents[0]
  if (!template) throw new Error("Missing synthetic preview agent")
  const agents = Array.from({ length: 20 }, (_, index) => ({
    ...template,
    key: `agent-${index}`,
    suggestedBotName: `agent-${index}`,
  }))
  getFixture({ "POST /api/v1/import/preview": { ...preview, agents } })
  enterWorkspace()
  continueSetup()
  await screen.findByRole("button", { name: /Claude Code/ })
  continueSetup()
  await screen.findByRole("heading", { name: "Confere o que vem?" })

  expect(screen.getByRole("button", { name: /Importar selecionados/ })).toBeDisabled()
  fireEvent.click(screen.getByRole("checkbox", { name: "Incluir agent-0", exact: true }))

  expect(screen.getByRole("button", { name: /Importar selecionados/ })).toBeEnabled()
})
it("counts agents already imported when the owner reviews another source", async () => {
  const preview = getGuidePreviewFixture()
  const agent = preview.agents[0]
  if (!agent) throw new Error("Missing synthetic preview agent")
  const agents = Array.from({ length: 19 }, (_, index) => ({
    ...agent,
    key: `agent-${index}`,
    suggestedBotName: `agent-${index}`,
  }))
  const previews = vi
    .fn()
    .mockResolvedValueOnce({ ...preview, agents })
    .mockResolvedValueOnce(getGuidePreviewFixture("next-preview"))
  getFixture({
    "POST /api/v1/import/preview": previews,
    "POST /api/v1/import/apply": {
      importId: "first-import",
      bots: agents.map((item) => ({ agentKey: item.key, botId: `bot-${item.key}` })),
      pausedRoutines: 19,
      reconnect: [],
    },
  })
  enterWorkspace()
  continueSetup()
  await screen.findByRole("button", { name: /Claude Code/ })
  continueSetup()
  await screen.findByRole("heading", { name: "Confere o que vem?" })
  fireEvent.click(screen.getByRole("button", { name: /Importar selecionados/ }))
  await screen.findAllByText("Pronto", { exact: true })
  fireEvent.click(screen.getByRole("button", { name: "Voltar", exact: true }))
  fireEvent.click(screen.getByRole("button", { name: "Voltar", exact: true }))

  continueSetup()

  await screen.findByRole("heading", { name: "Confere o que vem?" })
  expect(screen.getByRole("button", { name: /Importar selecionados/ })).toBeDisabled()
  expect(screen.getByRole("alert")).toHaveTextContent("Selecione até 19 agentes")
})
it("skips the team step when invite routes are absent", async () => {
  getFixture({ "GET /invites": new Error("NOT_SUPPORTED") })
  enterWorkspace()
  continueSetup()
  fireEvent.click(await screen.findByRole("button", { name: "Pular" }))
  continueSetup()
  await screen.findByRole("heading", { name: "Seu time de agentes" })

  continueSetup()

  await screen.findByRole("heading", { name: "O que eles fazem primeiro?" })
  expect(screen.queryByRole("button", { name: "Convidar pessoa" })).toBeNull()
})
it.each(["http://example.com", "file:///workspace/export.json", "https://user:password@example.com"])(
  "rejects a website outside HTTPS without credentials: %s",
  (website) => {
    expect(() => getWebsite(website)).toThrow()
  },
)
it.each([
  { bots: [getGuideBotFixture()], role: "admin", expected: false },
  { bots: [], role: "member", expected: false },
  { bots: [], role: "admin", expected: true },
])("preserves an existing server for role $role with setup=$expected", async ({ bots, role, expected }) => {
  const request = vi.fn(async (route) => (route === "GET /bots" ? { bots } : { person: { role } })) as UiApi["request"]
  const api: UiApi = { request, isMock: false, subscribe: () => () => undefined }

  expect(await getIsEmptyOwnerWorkspace(api)).toBe(expected)
})
it("uses actual progress events and rejects malformed or non-finite counters", () => {
  const progress = { importId: "one", agentKey: "dev", step: "skills", done: 1, total: 4 }

  expect(getImportProgress({ type: "agent-import.progress", progress })).toEqual(progress)
  expect(getImportProgress({ ...progress, total: Number.NaN })).toBeNull()
  expect(getImportProgress({ type: "import.progress", done: 1, total: 4 })).toBeNull()
})
it("translates every conversational setup string", () => {
  const keys = Object.keys(dictionaries["pt-BR"]).filter((key) =>
    key.startsWith("ob."),
  ) as (keyof typeof dictionaries.en)[]

  expect(keys.length).toBeGreaterThan(80)
  keys.forEach((key) => {
    expect(dictionaries.en[key]).not.toBe(key)
  })
})

it("returns from sources to context with the owner's answers intact", async () => {
  getFixture()
  enterWorkspace()
  fireEvent.change(screen.getByRole("textbox", { name: "Conte sobre seu trabalho" }), {
    target: { value: "Criamos ferramentas." },
  })
  continueSetup()
  await screen.findByRole("button", { name: /Claude Code/ })

  fireEvent.click(screen.getByRole("button", { name: "Voltar", exact: true }))

  expect(screen.getByRole("textbox", { name: "Conte sobre seu trabalho" })).toHaveValue("Criamos ferramentas.")
})
it("lets the owner configure permissions while importing but waits before loading agents", async () => {
  const pending = Promise.withResolvers<unknown>()
  const { request } = getFixture({ "POST /api/v1/import/apply": () => pending.promise })
  enterWorkspace()
  continueSetup()
  await screen.findByRole("button", { name: /Claude Code/ })
  continueSetup()
  await screen.findByRole("heading", { name: "Confere o que vem?" })
  fireEvent.click(screen.getByRole("button", { name: /Importar selecionados/ }))
  fireEvent.click(screen.getByRole("button", { name: /Continuar enquanto importa/ }))

  fireEvent.click(screen.getByRole("checkbox", { name: /Navegador/ }))

  expect(screen.getByRole("checkbox", { name: /Navegador/ })).toBeChecked()
  expect(screen.getByRole("button", { name: /^Continuar/ })).toBeDisabled()
  expect(request).not.toHaveBeenCalledWith("GET /bots", {})
  await act(async () => {
    pending.resolve({
      importId: "import-one",
      bots: [{ agentKey: "dev", botId: "bot-dev" }],
      pausedRoutines: 1,
      reconnect: [],
    })
  })
  await waitFor(() => expect(screen.getByRole("button", { name: /^Continuar/ })).toBeEnabled())
  continueSetup()
  await screen.findByRole("heading", { name: "Seu time de agentes" })
  expect(screen.getAllByRole("combobox", { name: "Conta de IA" })).toHaveLength(2)
})

it("preserves an existing agent's instructions when its name matches the guide", async () => {
  const existing = { ...getGuideBotFixture(), instructions: "Instruções revisadas pelo dono." }
  const { request } = getFixture({ "GET /bots": { bots: [existing] } })
  enterWorkspace()
  continueSetup()
  fireEvent.click(await screen.findByRole("button", { name: "Pular" }))
  continueSetup()
  await screen.findByRole("heading", { name: "Seu time de agentes" })

  continueSetup()

  await screen.findByRole("heading", { name: "Quem mais trabalha com você?" })
  expect(request).toHaveBeenCalledWith(
    "PATCH /bots/:id",
    expect.not.objectContaining({ instructions: expect.anything() }),
    { id: existing.id },
  )
})

it("keeps setup usable when import routes are not installed", async () => {
  getFixture({ "GET /api/v1/import/sources": new ApiError(404, "NOT_FOUND") })
  enterWorkspace()
  continueSetup()
  await screen.findByRole("alert")

  fireEvent.click(screen.getByRole("button", { name: "Pular", exact: true }))
  continueSetup()

  await screen.findByRole("heading", { name: "Seu time de agentes" })
})

it("retries an unchanged first task once and gives edited text a new message nonce", async () => {
  const send = vi
    .fn()
    .mockRejectedValueOnce(new Error("Response lost"))
    .mockRejectedValueOnce(new Error("Response lost"))
    .mockResolvedValue({})
  const { request } = getFixture({ "POST /threads/:id/messages": send })
  enterWorkspace()
  continueSetup()
  fireEvent.click(await screen.findByRole("button", { name: "Pular" }))
  continueSetup()
  await screen.findByRole("heading", { name: "Seu time de agentes" })
  continueSetup()
  await screen.findByRole("heading", { name: "Quem mais trabalha com você?" })
  fireEvent.click(screen.getByRole("button", { name: "Pular" }))
  fireEvent.change(screen.getByRole("textbox", { name: "Sua primeira tarefa" }), {
    target: { value: "Resuma o contexto." },
  })

  fireEvent.click(screen.getByRole("button", { name: /Enviar primeira tarefa/ }))
  await screen.findByRole("alert")
  fireEvent.click(screen.getByRole("button", { name: /Enviar primeira tarefa/ }))
  await screen.findByRole("alert")
  fireEvent.change(screen.getByRole("textbox", { name: "Sua primeira tarefa" }), {
    target: { value: "Organize as prioridades." },
  })
  fireEvent.click(screen.getByRole("button", { name: /Enviar primeira tarefa/ }))

  await screen.findByRole("heading", { name: "Seu touri está pronto" })
  const nonces = vi
    .mocked(request)
    .mock.calls.filter(([route]) => route === "POST /threads/:id/messages")
    .flatMap(([, input]) => ("clientNonce" in input ? [input.clientNonce] : []))
  expect(nonces).toHaveLength(3)
  expect(nonces[1]).toBe(nonces[0])
  expect(nonces[2]).not.toBe(nonces[1])
})

it("rejects batches that would evict the server's three preview tickets", async () => {
  const sources = Array.from({ length: 4 }, (_, index) => ({
    id: `folder-${index}`,
    kind: "folder" as const,
    label: "Pasta exemplo",
    found: true,
    path: `/workspace/source-${index}`,
  }))
  const { request } = getFixture({ "GET /api/v1/import/sources": { sources } })
  enterWorkspace()
  continueSetup()
  await waitFor(() => expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(4))

  continueSetup()

  expect(await screen.findByRole("alert")).toHaveTextContent("Escolha até 3 fontes")
  expect(request).not.toHaveBeenCalledWith("POST /api/v1/import/preview", expect.anything())
})

it.each([
  { state: "ready", executable: "missing" },
  { state: "idle", executable: "available" },
])("returns to account setup before sending to an unready agent: $state/$executable", async (status) => {
  const { request, complete } = getFixture({
    "GET /bots/:id/provider-login/flow": { provider: "claude", ...status },
  })
  enterWorkspace()
  continueSetup()
  fireEvent.click(await screen.findByRole("button", { name: "Pular" }))
  continueSetup()
  await screen.findByRole("heading", { name: "Seu time de agentes" })
  continueSetup()
  await screen.findByRole("heading", { name: "Quem mais trabalha com você?" })
  fireEvent.click(screen.getByRole("button", { name: "Pular" }))
  fireEvent.change(screen.getByRole("textbox", { name: "Sua primeira tarefa" }), {
    target: { value: "Organize as prioridades." },
  })

  fireEvent.click(screen.getByRole("button", { name: /Enviar primeira tarefa/ }))

  await screen.findByRole("heading", { name: "Seu time de agentes" })
  expect(screen.getByRole("alert")).toHaveTextContent("Conecte a conta de touri")
  expect(vi.mocked(request).mock.calls.some(([route]) => route === "POST /threads/:id/messages")).toBe(false)
  expect(complete).not.toHaveBeenCalled()
})

it("undoes a completed import from the source screen and removes its preview", async () => {
  const { request } = getFixture()
  enterWorkspace()
  continueSetup()
  await screen.findByRole("button", { name: /Claude Code/ })
  continueSetup()
  await screen.findByRole("heading", { name: "Confere o que vem?" })
  fireEvent.click(screen.getByRole("button", { name: /Importar selecionados/ }))
  await screen.findByText("Pronto", { selector: ".ob-import-agent span" })
  continueSetup()
  fireEvent.click(screen.getByRole("button", { name: "Voltar", exact: true }))

  fireEvent.click(await screen.findByRole("button", { name: /Desfazer importação/ }))

  await waitFor(() => expect(request).toHaveBeenCalledWith("POST /api/v1/import/undo", { importId: "import-one" }))
  await waitFor(() => expect(screen.queryByRole("button", { name: /Desfazer importação/ })).toBeNull())
  expect(within(screen.getByRole("complementary")).queryByText("dev")).toBeNull()
})

it("confirms an undo from the importing screen and returns to source selection", async () => {
  getFixture()
  enterWorkspace()
  continueSetup()
  await screen.findByRole("button", { name: /Claude Code/ })
  continueSetup()
  await screen.findByRole("heading", { name: "Confere o que vem?" })
  fireEvent.click(screen.getByRole("button", { name: /Importar selecionados/ }))
  await screen.findByText("Pronto", { selector: ".ob-import-agent span" })

  fireEvent.click(screen.getByRole("button", { name: "Desfazer importação de dev" }))

  await screen.findByRole("heading", { name: "Já usa agentes em outro app?" })
  expect(screen.getByRole("status")).toHaveTextContent("Importação desfeita. Removemos dev.")
  expect(screen.getByRole("button", { name: /Claude Code/ })).toBeVisible()
  expect(screen.queryByRole("button", { name: /Desfazer importação/ })).toBeNull()
})

it("keeps an earlier import named after reviewing another source", async () => {
  const previews = vi
    .fn()
    .mockResolvedValueOnce(getGuidePreviewFixture())
    .mockResolvedValueOnce(getGuidePreviewFixture("next-preview"))
  getFixture({ "POST /api/v1/import/preview": previews })
  enterWorkspace()
  continueSetup()
  await waitFor(() => expect(screen.getByRole("button", { name: /^Continuar/ })).toBeEnabled())
  continueSetup()
  await screen.findByRole("heading", { name: "Confere o que vem?" })
  fireEvent.click(screen.getByRole("button", { name: /Importar selecionados/ }))
  await screen.findByText("Pronto", { selector: ".ob-import-agent span" })
  fireEvent.click(screen.getByRole("button", { name: "Voltar", exact: true }))
  fireEvent.click(screen.getByRole("button", { name: "Voltar", exact: true }))

  continueSetup()
  await screen.findByRole("heading", { name: "Confere o que vem?" })
  fireEvent.click(screen.getByRole("button", { name: "Voltar", exact: true }))

  const undo = screen.getByRole("button", { name: "Desfazer importação de dev", exact: true })
  fireEvent.click(undo)
  await screen.findByRole("status")
  expect(screen.getByRole("status")).toHaveTextContent("Importação desfeita. Removemos dev.")
})

it("explains the invite prerequisite before asking for a person's details", async () => {
  const request = vi.fn(async () => ({ address: null, reachability: "unset" })) as UiApi["request"]
  const api: UiApi = { request, isMock: false, subscribe: () => () => undefined }

  render(<TeamFields api={api} groups={[]} onInvited={vi.fn()} />)

  await waitFor(() => expect(request).toHaveBeenCalledWith("GET /public-address", {}, {}, expect.anything()))
  expect(screen.getByRole("status")).toHaveTextContent("configure um endereço HTTPS")
  expect(screen.queryByRole("button", { name: "Convidar pessoa" })).toBeNull()
  expect(screen.queryByRole("dialog")).toBeNull()
})

it("persists the reviewed avatar seed on the imported agent without changing its instructions", async () => {
  const { request } = getFixture()
  enterWorkspace()
  continueSetup()
  await screen.findByRole("button", { name: /Claude Code/ })
  continueSetup()
  await screen.findByRole("heading", { name: "Confere o que vem?" })
  fireEvent.click(screen.getByRole("button", { name: /Importar selecionados/ }))
  await screen.findByText("Pronto", { selector: ".ob-import-agent span" })
  continueSetup()
  continueSetup()
  await screen.findByRole("heading", { name: "Seu time de agentes" })

  continueSetup()

  await screen.findByRole("heading", { name: "Quem mais trabalha com você?" })
  expect(request).toHaveBeenCalledWith("PATCH /bots/:id", expect.objectContaining({ avatarSeed: "dev", color: null }), {
    id: "bot-dev",
  })
  const imported = vi
    .mocked(request)
    .mock.calls.find(([route, , paths]) => route === "PATCH /bots/:id" && paths?.id === "bot-dev")
  expect(imported?.[1]).not.toHaveProperty("instructions")
})

it("keeps unsaved account choices when returning to computer permissions", async () => {
  getFixture()
  enterWorkspace()
  continueSetup()
  fireEvent.click(await screen.findByRole("button", { name: "Pular" }))
  continueSetup()
  await screen.findByRole("heading", { name: "Seu time de agentes" })
  fireEvent.change(screen.getByRole("combobox", { name: "Conta de IA" }), { target: { value: "codex" } })

  fireEvent.click(screen.getByRole("button", { name: "Voltar", exact: true }))
  continueSetup()

  await screen.findByRole("heading", { name: "Seu time de agentes" })
  expect(screen.getByRole("combobox", { name: "Conta de IA" })).toHaveValue("codex")
})
it("retains an import when undo fails so the owner can retry", async () => {
  const undo = vi.fn().mockRejectedValueOnce(new Error("Connection interrupted")).mockResolvedValue({ removedBots: 1 })
  getFixture({ "POST /api/v1/import/undo": undo })
  enterWorkspace()
  continueSetup()
  await screen.findByRole("button", { name: /Claude Code/ })
  continueSetup()
  await screen.findByRole("heading", { name: "Confere o que vem?" })
  fireEvent.click(screen.getByRole("button", { name: /Importar selecionados/ }))
  await screen.findByText("Pronto", { selector: ".ob-import-agent span" })

  fireEvent.click(screen.getByRole("button", { name: /Desfazer importação/ }))

  expect(await screen.findByRole("alert")).toHaveTextContent("Não conseguimos desfazer")
  expect(within(screen.getByRole("complementary")).getByText("dev")).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: /Desfazer importação/ }))
  await waitFor(() => expect(screen.queryByRole("button", { name: /Desfazer importação/ })).toBeNull())
})
