import { act, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Message } from "@touri/contracts"
import { describe, expect, it } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import groupE2eSource from "./e2e/groups.spec.ts?raw"

const openGroupPanel = (name: string): HTMLElement => {
  if (!screen.queryByRole("complementary", { name: `Painel do canal ${name}` }))
    fireEvent.click(screen.getByRole("button", { name: /^Membros do canal:/ }))
  return screen.getByRole("complementary", { name: `Painel do canal ${name}` })
}

describe("Grupos", () => {
  it("keeps an empty channel list ready to create a channel", async () => {
    const api = createMockApi()
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    fireEvent.click(screen.getByRole("tab", { name: /^Work,/ }))

    const groups = screen.getByRole("region", { name: "Canais" })
    const createGroup = within(groups).getByRole("button", { name: "Novo canal" })
    expect(createGroup).toBeVisible()
    expect(createGroup).toHaveTextContent("+")
    expect(groups.querySelector(".group-sidebar-heading")).toHaveTextContent(/^Canais\s*(\+ Convidar)?\s*\+$/)
    expect(within(groups).getByText("Nenhum canal ainda")).toBeVisible()
    expect(within(groups).getByText("Canais reúnem bots e pessoas em torno de um assunto.")).toBeVisible()
    expect(within(groups).getByRole("button", { name: "Criar canal" })).toBeVisible()
    expect(within(groups).queryByText("Reúna seus bots em uma conversa.")).toBeNull()

    fireEvent.click(createGroup)

    expect(screen.getByRole("dialog", { name: "Criar canal" })).toBeVisible()
  })

  it("F026: exposes every mention and announces arrow selection", async () => {
    const user = userEvent.setup()
    const api = createMockApi()
    const [first, second] = api.getState().bots
    if (!first || !second) throw new Error("Missing members")
    first.name = "Bia QA"
    second.name = "Nico VM QA"
    await api.request("POST /groups", {
      name: "Equipe QA",
      color: "#dc2626",
      avatarShape: "classic-none",
      memberIds: [first.id, second.id],
      coordinatorBotId: first.id,
    })
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para Bia QA" })
    fireEvent.click(screen.getByRole("tab", { name: /^Work,/ }))
    await user.click(screen.getByRole("button", { name: /^Equipe QA/ }))
    const input = await screen.findByRole("textbox", { name: "Mensagem para Equipe QA" })
    await user.click(input)
    await user.type(input, "@")
    const list = screen.getByRole("listbox", { name: "Mencionar membro" })
    const options = within(list).getAllByRole("option")
    expect(options).toHaveLength(2)
    expect(options[0]).toHaveAccessibleName("@Bia QA")
    expect(options[1]).toHaveAccessibleName("@Nico VM QA")
    expect(document.getElementById(input.getAttribute("aria-activedescendant") ?? "")).toBe(options[0])
    await user.keyboard("{ArrowDown}")
    expect(options[1]).toHaveAttribute("aria-selected", "true")
    expect(document.getElementById(input.getAttribute("aria-activedescendant") ?? "")).toBe(options[1])
    expect(input).toHaveFocus()
    await user.keyboard("{Enter}")
    expect(input).toHaveValue('@"Nico VM QA" ')
    expect(input).not.toHaveAttribute("aria-activedescendant")
    expect(screen.queryByRole("listbox", { name: "Mencionar membro" })).toBeNull()
    await user.clear(input)
    await user.type(input, "@")
    await user.keyboard("{ArrowUp}")
    expect(
      within(screen.getByRole("listbox", { name: "Mencionar membro" })).getByRole("option", { name: "@Nico VM QA" }),
    ).toHaveAttribute("aria-selected", "true")
    await user.keyboard("{Enter}")
    expect(input).toHaveValue('@"Nico VM QA" ')
  })

  it("keeps the group e2e's first panel selector consistent with the rendered group context", async () => {
    // Check the spec's actual selector against the UI without starting Playwright or a browser.
    const panelName = groupE2eSource.match(/getByRole\("complementary", \{ name: "([^"]+)"/)?.[1]
    if (!panelName) throw new Error("Group e2e must assert its panel context")
    const api = createMockApi()
    await api.request("POST /groups", {
      name: "Produto",
      color: "#dc2626",
      avatarShape: "classic-none",
      memberIds: ["bot-mark", "bot-onb"],
      coordinatorBotId: "bot-mark",
    })
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    fireEvent.click(screen.getByRole("tab", { name: /^Work,/ }))
    fireEvent.click(within(screen.getByRole("region", { name: "Canais" })).getByRole("button", { name: /^Produto/ }))
    await screen.findByRole("textbox", { name: "Mensagem para Produto" })
    if (!screen.queryByRole("complementary", { name: panelName, exact: true }))
      fireEvent.click(screen.getByRole("button", { name: /^Membros do canal:/ }))
    const panel = screen.getByRole("complementary", { name: panelName, exact: true })
    expect(within(panel).getByRole("list", { name: "Membros do canal" })).toHaveTextContent("mark")
    expect(within(panel).getByText("Coordenador", { exact: true })).toBeVisible()
    expect(within(panel).getByText("Os bots só respondem quando você os chama com @nome.")).toBeVisible()
    expect(within(panel).queryByRole("button", { name: "Preview do projeto" })).toBeNull()
    fireEvent.click(screen.getByRole("tab", { name: /^Bots,/ }))
    const botEntry = document.querySelector('[data-bot-entry="bot-mark"] .bot-row-main')
    if (!botEntry) throw new Error("Missing bot entry")
    fireEvent.click(botEntry)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    const botPanel = screen.getByRole("complementary", { name: "Painel de mark" })
    expect(within(botPanel).getByRole("button", { name: "Preview do projeto" })).toBeVisible()
    fireEvent.click(within(botPanel).getByRole("button", { name: "Produto · coordenador" }))
    await screen.findByRole("textbox", { name: "Mensagem para Produto" })
    expect(screen.getByRole("complementary", { name: panelName, exact: true })).toBeVisible()
  })

  it("introduces every member and group routing without showing the first bot's settings", async () => {
    const api = createMockApi()
    await api.request("POST /groups", {
      name: "Equipe QA",
      color: "#dc2626",
      avatarShape: "classic-none",
      memberIds: ["bot-mark", "bot-onb"],
      coordinatorBotId: null,
    })
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    fireEvent.click(screen.getByRole("tab", { name: /^Work,/ }))
    fireEvent.click(within(screen.getByRole("region", { name: "Canais" })).getByRole("button", { name: /^Equipe QA/ }))
    await screen.findByRole("textbox", { name: "Mensagem para Equipe QA" })
    const welcome = screen.getByRole("region", { name: "Comece a conversa em #Equipe QA" })
    expect(within(welcome).getByRole("heading", { name: "Comece a conversa em #Equipe QA" })).toBeVisible()
    expect(within(welcome).getByText("Os bots só respondem quando você os chama com @nome.")).toBeVisible()
    expect(within(welcome).getByRole("list", { name: "Membros do canal" })).toHaveTextContent("mark")
    expect(within(welcome).getByRole("list", { name: "Membros do canal" })).toHaveTextContent("onb")
    expect(screen.queryByRole("heading", { name: "Comece uma conversa com mark" })).toBeNull()
    const panel = openGroupPanel("Equipe QA")
    expect(within(panel).getByText("Seu canal")).toBeVisible()
    expect(within(panel).queryByRole("button", { name: "Preview do projeto" })).toBeNull()
    expect(screen.queryByRole("complementary", { name: "Painel de mark" })).toBeNull()
    fireEvent.click(within(panel).getByRole("button", { name: "Fechar painel do canal" }))
    fireEvent.click(screen.getByRole("button", { name: /^Membros do canal:/ }))
    const channelPanel = screen.getByRole("complementary", { name: "Painel do canal Equipe QA" })
    expect(channelPanel).toBeVisible()
    expect(within(channelPanel).getByText("Os bots só respondem quando você os chama com @nome.")).toBeVisible()
  })

  it("creates a group, completes @mentions with keyboard, edits membership and opens own conversations", async () => {
    const api = createMockApi()
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    fireEvent.click(screen.getByRole("tab", { name: /^Work,/ }))
    fireEvent.click(screen.getByRole("button", { name: "Novo canal" }))
    const modal = screen.getByRole("dialog", { name: "Criar canal" })
    fireEvent.change(within(modal).getByLabelText("Nome do canal"), { target: { value: "Produto" } })
    fireEvent.click(within(modal).getByLabelText("mark"))
    fireEvent.click(within(modal).getByLabelText("onb"))
    fireEvent.change(within(modal).getByLabelText("Coordenador do canal"), { target: { value: "bot-mark" } })
    fireEvent.click(within(modal).getByRole("button", { name: "Criar canal" }))
    const composer = await screen.findByRole("textbox", { name: "Mensagem para Produto" })
    const header = within(document.querySelector(".group-header") as HTMLElement)
    expect(header.getByRole("button", { name: "Membros do canal: 2 bots" })).toBeVisible()
    const payload = api.calls.find((c) => c.route === "POST /groups")?.input
    expect(payload).toMatchObject({ name: "Produto", memberIds: ["bot-mark", "bot-onb"], coordinatorBotId: "bot-mark" })
    fireEvent.focus(composer)
    fireEvent.change(composer, { target: { value: "@on", selectionStart: 3 } })
    expect(screen.getByRole("option", { name: "@onb" })).toBeVisible()
    fireEvent.keyDown(composer, { key: "Enter" })
    expect(composer).toHaveValue("@onb ")
    expect(api.calls.filter((c) => c.route === "POST /threads/:id/messages")).toHaveLength(0)
    fireEvent.click(header.getByRole("button", { name: "Ações do canal Produto" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Editar canal" }))
    const edit = screen.getByRole("dialog", { name: "Editar canal" })
    fireEvent.click(within(edit).getByLabelText("mark"))
    expect(within(edit).getByLabelText("Coordenador do canal")).toHaveValue("")
    fireEvent.click(within(edit).getByRole("button", { name: "Salvar canal" }))
    await screen.findByRole("textbox", { name: "Mensagem para Produto" })
    expect(header.getByRole("button", { name: "Membros do canal: 1 bot" })).toBeVisible()
    expect(api.calls.find((c) => c.route === "PATCH /groups/:id")?.input).toMatchObject({
      memberIds: ["bot-onb"],
      coordinatorBotId: null,
    })
    fireEvent.click(
      within(screen.getByRole("region", { name: "Canais" })).getByRole("button", { name: "Ações do canal Produto" }),
    )
    fireEvent.click(screen.getByRole("menuitem", { name: "Nova conversa" }))
    await within(screen.getByRole("region", { name: "Canais" })).findByRole("button", {
      name: "Nova conversa",
    })
    expect(api.calls.some((c) => c.route === "POST /groups/:id/threads")).toBe(true)
  })
  it("F028: preserves sender identity with a neutral deleted-member avatar in existing history", async () => {
    const api = createMockApi()
    const created = await api.request("POST /groups", {
      name: "Equipe",
      color: "#dc2626",
      avatarShape: "classic-none",
      memberIds: ["bot-mark", "bot-onb"],
      coordinatorBotId: "bot-mark",
    })
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    fireEvent.click(screen.getByRole("tab", { name: /^Work,/ }))
    fireEvent.click(screen.getByRole("button", { name: /^Equipe/ }))
    await screen.findByRole("textbox", { name: "Mensagem para Equipe" })
    const message: Message = {
      id: "group-reply",
      threadId: created.thread.id,
      parentId: null,
      role: "assistant",
      kind: "text",
      status: "complete",
      runId: null,
      text: "Revisão concluída",
      parts: [{ type: "text", text: "Revisão concluída" }],
      sender: { id: "bot-onb", name: "onb" },
      source: "local",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    act(() => api.emit({ type: "message.created", message }))
    const row = document.querySelector('[data-message-id="group-reply"]')
    expect(row?.querySelector(".message-role")?.textContent).toBe("onb")
    expect(row?.querySelector(".tb-avatar")).toBeTruthy()
    expect(row?.querySelector(".tb-avatar")).toHaveAttribute("data-bot-id", "bot-onb")
    await act(async () => {
      await api.request("DELETE /bots/:id", { name: "onb", deleteVolumes: false }, { id: "bot-onb" })
    })
    const deleted = await within(row as HTMLElement).findByRole("img", { name: "Membro excluído: onb" })
    const header = within(document.querySelector(".group-header") as HTMLElement)
    expect(header.getByRole("button", { name: "Membros do canal: 1 bot" })).toBeVisible()
    expect(deleted.querySelector(".tb-avatar")).toHaveAttribute("data-bot-id", "bot-onb")
    expect(row?.querySelector('[data-bot-id="bot-mark"]')).toBeNull()
    expect(row?.querySelector(".message-role")).toHaveTextContent("onb")
    const groupPanel = openGroupPanel("Equipe")
    expect(within(groupPanel).getByText("Os bots só respondem quando você os chama com @nome.")).toBeVisible()
    expect(within(groupPanel).getByText("Coordenador")).toBeVisible()
    fireEvent.click(screen.getByRole("tab", { name: /^Bots,/ }))
    const botRow = document.querySelector<HTMLButtonElement>('[data-bot-entry="bot-mark"] button.bot-row-main')
    if (!botRow) throw new Error("Missing bot row")
    fireEvent.click(botRow)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    if (!screen.queryByRole("complementary", { name: "Painel de mark" }))
      fireEvent.click(screen.getByRole("button", { name: "Painel do bot" }))
    const panel = screen.getByRole("complementary", { name: "Painel de mark" })
    expect(within(panel).getByRole("heading", { name: "Grupos" })).toBeVisible()
    expect(within(panel).getByRole("button", { name: "Equipe · coordenador" })).toBeVisible()
  })
})
