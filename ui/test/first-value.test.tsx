import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { Bot } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { ConversationStart } from "../src/components/ConversationStart"
import { BotCreateModal } from "../src/components/Modals"
import { adoptProviderLogin } from "../src/features/bots/providerLogin"
import { getJobTemplates } from "../src/features/jobs/catalog"
import { dictionaries, getHostLabel, t } from "../src/i18n"

afterEach(cleanup)

it.each(["mac", "computer", "server"] as const)(
  "describes local history and necessary AI disclosure for the real %s host",
  async (host) => {
    const api = createMockApi()
    api.getState().bots.splice(0)
    const original = api.request
    api.request = (async (route, input, path) =>
      route === "GET /health"
        ? { ok: true, version: "test", schemaVersion: 1, host: host === "mac" ? "mac" : "server", hostKind: host }
        : original(route, input, path)) as ApiRequest
    render(<App kernel={{ services: { api } }} />)
    const privacy = await screen.findByText(t("onboarding.privacy", { host: getHostLabel(host) }))
    expect(privacy).toHaveTextContent("Sua IA recebe o conteúdo necessário")
    expect(document.body.textContent).not.toMatch(/Nada sai daqui|Nothing leaves/)
    if (host !== "mac") expect(document.body.textContent).not.toContain("Mac")
  },
)

it.each(["mac", "computer", "server"] as const)(
  "shows installation before readiness on %s and keeps the whole draft across recheck",
  async (host) => {
    const api = createMockApi()
    let installed = false
    const original = api.request
    const request = vi.fn(async (route, input, path) => {
      if (route === "GET /bots/:id/provider-login/flow")
        return {
          provider: input.provider,
          state: "host-available",
          host: host === "mac" ? "mac" : "server",
          hostKind: host,
          executable: installed ? "available" : "missing",
        }
      if (route === "POST /bots/:id/provider-login/flow")
        return {
          provider: input.provider,
          state: "ready",
          host: host === "mac" ? "mac" : "server",
          hostKind: host,
          executable: installed ? "available" : "missing",
        }
      return original(route, input, path)
    })
    api.request = request as ApiRequest
    const create = vi.fn(async () => {})
    render(<BotCreateModal api={api} onClose={vi.fn()} onCreate={create} />)
    await screen.findByText(`O Codex ainda não está instalado neste ${getHostLabel(host)}.`)
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Clara" } })
    fireEvent.click(screen.getByRole("radio", { name: "Caderno em ordem" }))
    fireEvent.click(screen.getByRole("radio", { name: "Chifres Longos" }))
    fireEvent.click(screen.getByRole("radio", { name: "Acessório Coroa" }))
    const avatar = document.querySelector(".avatar-picker-preview .tb-avatar")?.getAttribute("data-bot-id")
    fireEvent.click(screen.getByRole("button", { name: "Criar bot", exact: true }))
    expect(create).not.toHaveBeenCalled()
    expect(screen.queryByText(/Usa o Codex/)).toBeNull()
    expect(request.mock.calls.some(([route]) => route.startsWith("POST"))).toBe(false)
    expect(screen.getByRole("link", { name: "Ver como instalar" })).toHaveAttribute("target", "_blank")
    installed = true
    fireEvent.click(screen.getByRole("button", { name: "Verificar novamente" }))
    await screen.findByText(`Usa o Codex, conectado neste ${getHostLabel(host)}.`)
    expect(screen.getByLabelText("Nome")).toHaveValue("Clara")
    expect(screen.getByRole("radio", { name: "Caderno em ordem" })).toBeChecked()
    expect(document.querySelector(".avatar-picker-preview .tb-avatar")?.getAttribute("data-bot-id")).toBe(avatar)
    expect(screen.getByRole("radio", { name: "Chifres Longos" })).toBeChecked()
    fireEvent.click(screen.getByRole("button", { name: "Criar bot", exact: true }))
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Clara",
          roleLine: getJobTemplates()[0]?.roleLine,
          avatarSeed: avatar,
          avatarShape: "long-crown",
        }),
        expect.stringMatching(/^draft-/),
      ),
    )
  },
)

it.each(getJobTemplates())(
  "$id offers a self-contained example or an explicit source action without claiming unseen context",
  (job) => {
    const choose = vi.fn()
    const folder = vi.fn()
    const attach = vi.fn()
    const bot = {
      id: "first",
      name: "Clara",
      machine: "local",
      roleLine: job.roleLine,
      instructions: job.instructions,
      projectId: null,
      folders: [],
      anyFolderAccess: false,
    } as unknown as Bot
    render(<ConversationStart bot={bot} onChoose={choose} onFolder={folder} onAttach={attach} />)
    fireEvent.click(screen.getByRole("button", { name: "Usar exemplo" }))
    expect(choose).toHaveBeenCalledExactlyOnceWith(t("onboarding.examplePrompt"))
    expect(choose.mock.calls[0]?.[0]).toContain("lista em português do Brasil")
    expect(choose.mock.calls[0]?.[0]).toContain("Comprar café; revisar orçamento; marcar reunião.")
    expect(screen.queryByText("Explique o repositório conectado.")).toBeNull()
    if (["repository-map", "critical-tests", "change-explainer", "dependency-plan"].includes(job.id)) {
      fireEvent.click(screen.getByRole("button", { name: "Escolher pasta do repositório" }))
      expect(folder).toHaveBeenCalledOnce()
    }
    fireEvent.click(screen.getByRole("button", { name: "Anexar arquivo" }))
    expect(attach).toHaveBeenCalledOnce()
  },
)

it("fills and sends the Portuguese example with no project, folder, attachment, or integration", async () => {
  const api = createMockApi()
  api.getState().bots.splice(0)
  api.getState().threads.splice(0)
  render(<App kernel={{ services: { api } }} />)
  fireEvent.click(await screen.findByRole("button", { name: "Criar meu primeiro bot" }))
  fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Clara" } })
  await screen.findByText(/Usa o Codex/)
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Criar bot", exact: true }))
  const composer = await screen.findByRole("textbox", { name: "Mensagem para Clara" })
  fireEvent.click(await screen.findByRole("button", { name: "Usar exemplo" }))
  expect(composer).toHaveValue(t("onboarding.examplePrompt"))
  expect(composer).toHaveFocus()
  expect(api.calls.filter((call) => call.route === "POST /threads/:id/messages")).toHaveLength(0)
  fireEvent.keyDown(composer, { key: "Enter" })
  await waitFor(() => expect(api.calls.filter((call) => call.route === "POST /threads/:id/messages")).toHaveLength(1))
  const send = api.calls.find((call) => call.route === "POST /threads/:id/messages")
  expect(send?.input).toMatchObject({ text: t("onboarding.examplePrompt"), attachmentIds: [] })
  expect(api.getState().bots.find((bot) => bot.name === "Clara")).toMatchObject({ projectId: null, folders: [] })
})

it("has matching English for the entire first-value copy block", () => {
  const keys = Object.keys(dictionaries["pt-BR"]).filter((key) => key.startsWith("onboarding."))
  expect(keys.length).toBeGreaterThan(15)
  for (const key of keys) {
    expect(dictionaries.en[key as keyof typeof dictionaries.en]).toBeTruthy()
    expect(dictionaries.en[key as keyof typeof dictionaries.en]).not.toBe(
      dictionaries["pt-BR"][key as keyof typeof dictionaries.en],
    )
  }
})

it("cloud repository work asks for an attachment without offering a host folder", () => {
  const job = getJobTemplates().find((job) => job.id === "repository-map")
  const attach = vi.fn()
  render(
    <ConversationStart
      bot={{ id: "cloud", name: "Clara", machine: "cloud", roleLine: job?.roleLine } as Bot}
      onChoose={vi.fn()}
      onFolder={vi.fn()}
      onAttach={attach}
    />,
  )
  expect(screen.queryByRole("button", { name: "Escolher pasta do repositório" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Anexar arquivo" }))
  expect(attach).toHaveBeenCalledOnce()
})

it("does not report successful adoption if the executable disappears after creation checks", async () => {
  const api = createMockApi()
  api.request = vi.fn(async () => ({
    provider: "codex",
    state: "ready",
    executable: "missing",
    host: "server",
  })) as ApiRequest
  await expect(adoptProviderLogin(api, { id: "created", provider: "codex" } as Bot, "draft-test")).rejects.toThrow(
    "Login unavailable",
  )
})

it("an existing bot with saved login and a missing executable cannot send until installation is rechecked", async () => {
  const api = createMockApi()
  const original = api.request
  let installed = false
  api.request = (async (route, input, path) => {
    if (route === "GET /bots/:id/provider-login/flow")
      return {
        provider: "codex",
        state: "ready",
        host: "server",
        executable: installed ? "available" : "missing",
      }
    return original(route, input, path)
  }) as ApiRequest
  render(<App kernel={{ services: { api } }} />)
  const composer = await screen.findByRole("textbox", { name: "Mensagem para mark" })
  await screen.findByText("O Codex ainda não está instalado neste servidor.")
  fireEvent.change(composer, { target: { value: "Olá" } })
  fireEvent.keyDown(composer, { key: "Enter" })
  expect(api.calls.filter((call) => call.route === "POST /threads/:id/messages")).toHaveLength(0)
  await waitFor(() => expect(screen.getByRole("button", { name: "Verificar novamente" })).toBeEnabled())
  installed = true
  fireEvent.click(screen.getByRole("button", { name: "Verificar novamente" }))
  await waitFor(() => expect(screen.queryByText("O Codex ainda não está instalado neste servidor.")).toBeNull())
  fireEvent.keyDown(composer, { key: "Enter" })
  await waitFor(() => expect(api.calls.filter((call) => call.route === "POST /threads/:id/messages")).toHaveLength(1))
})
