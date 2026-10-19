import { act, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Message } from "@touri/contracts"
import { describe, expect, it } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import groupE2eSource from "./e2e/groups.spec.ts?raw"

const openGroupPanel = (name: string): HTMLElement => {
  if (!screen.queryByRole("complementary", { name: `Painel do grupo ${name}` }))
    fireEvent.click(screen.getByRole("button", { name: "Painel do grupo" }))
  return screen.getByRole("complementary", { name: `Painel do grupo ${name}` })
}

describe("Grupos", () => {
  it("keeps an empty group list to one compact create action", async () => {
    const api = createMockApi()
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })

    const groups = screen.getByRole("region", { name: "Grupos" })
    const createGroup = within(groups).getByRole("button", { name: "Criar grupo" })
    expect(createGroup).toBeVisible()
    expect(groups.querySelector(".group-sidebar-heading")).toBeNull()
    expect(within(groups).queryByText("Reúna seus bots em uma conversa.")).toBeNull()

    fireEvent.click(createGroup)

    expect(screen.getByRole("dialog", { name: "Criar grupo" })).toBeVisible()
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
    await user.click(screen.getByRole("button", { name: /^Equipe QA$/ }))
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
    fireEvent.click(within(screen.getByRole("region", { name: "Grupos" })).getByRole("button", { name: "Produto" }))
    await screen.findByRole("textbox", { name: "Mensagem para Produto" })
    if (!screen.queryByRole("complementary", { name: panelName, exact: true }))
      fireEvent.click(screen.getByRole("button", { name: "Painel do grupo" }))
    const panel = screen.getByRole("complementary", { name: panelName, exact: true })
    expect(within(panel).getByRole("list", { name: "Membros do grupo" })).toHaveTextContent("mark")
    expect(within(panel).getByText("Coordenador", { exact: true })).toBeVisible()
    expect(within(panel).getByText(/mark coordena as respostas/)).toBeVisible()
    expect(within(panel).queryByRole("button", { name: "Preview do projeto" })).toBeNull()
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
    fireEvent.click(within(screen.getByRole("region", { name: "Grupos" })).getByRole("button", { name: "Equipe QA" }))
    await screen.findByRole("textbox", { name: "Mensagem para Equipe QA" })
    const welcome = screen.getByRole("region", { name: "Comece uma conversa com Equipe QA" })
    expect(within(welcome).getByRole("heading", { name: "Comece uma conversa com Equipe QA" })).toBeVisible()
    expect(within(welcome).getByText(/todos os membros respondem na ordem da lista/)).toBeVisible()
    expect(within(welcome).getByRole("list", { name: "Membros do grupo" })).toHaveTextContent("mark")
    expect(within(welcome).getByRole("list", { name: "Membros do grupo" })).toHaveTextContent("onb")
    expect(screen.queryByRole("heading", { name: "Comece uma conversa com mark" })).toBeNull()
    const panel = openGroupPanel("Equipe QA")
    expect(within(panel).getByText("Seu grupo")).toBeVisible()
    expect(within(panel).queryByRole("button", { name: "Preview do projeto" })).toBeNull()
    expect(screen.queryByRole("complementary", { name: "Painel de mark" })).toBeNull()
    fireEvent.click(within(panel).getByRole("button", { name: "Fechar painel do grupo" }))
    fireEvent.click(screen.getByRole("button", { name: "Painel do grupo" }))
    expect(screen.getByRole("complementary", { name: "Painel do grupo Equipe QA" })).toBeVisible()
  })

  it("creates a group, completes @mentions with keyboard, edits membership and opens own conversations", async () => {
    const api = createMockApi()
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    fireEvent.click(screen.getByRole("button", { name: "Criar grupo" }))
    const modal = screen.getByRole("dialog", { name: "Criar grupo" })
    fireEvent.change(within(modal).getByLabelText("Nome do grupo"), { target: { value: "Produto" } })
    fireEvent.click(within(modal).getByLabelText("mark"))
    fireEvent.click(within(modal).getByLabelText("onb"))
    fireEvent.change(within(modal).getByLabelText("Coordenador"), { target: { value: "bot-mark" } })
    fireEvent.click(within(modal).getByRole("button", { name: "Criar grupo" }))
    const composer = await screen.findByRole("textbox", { name: "Mensagem para Produto" })
    expect(screen.getByText("mark · coordenador, onb")).toBeVisible()
    const header = within(document.querySelector(".group-header") as HTMLElement)
    expect(header.getByText("2 membros", { exact: true })).toBeVisible()
    expect(header.getByRole("img", { name: "2 membros: mark, onb", exact: true })).toBeVisible()
    const payload = api.calls.find((c) => c.route === "POST /groups")?.input
    expect(payload).toMatchObject({ name: "Produto", memberIds: ["bot-mark", "bot-onb"], coordinatorBotId: "bot-mark" })
    fireEvent.focus(composer)
    fireEvent.change(composer, { target: { value: "@on", selectionStart: 3 } })
    expect(screen.getByRole("option", { name: "@onb" })).toBeVisible()
    fireEvent.keyDown(composer, { key: "Enter" })
    expect(composer).toHaveValue("@onb ")
    expect(api.calls.filter((c) => c.route === "POST /threads/:id/messages")).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: "Editar grupo" }))
    const edit = screen.getByRole("dialog", { name: "Editar grupo" })
    fireEvent.click(within(edit).getByLabelText("mark"))
    expect(within(edit).getByLabelText("Coordenador")).toHaveValue("")
    fireEvent.click(within(edit).getByRole("button", { name: "Salvar grupo" }))
    await screen.findByRole("textbox", { name: "Mensagem para Produto" })
    expect(header.getByText("1 membro", { exact: true })).toBeVisible()
    expect(header.getByRole("img", { name: "1 membro: onb", exact: true })).toBeVisible()
    expect(api.calls.find((c) => c.route === "PATCH /groups/:id")?.input).toMatchObject({
      memberIds: ["bot-onb"],
      coordinatorBotId: null,
    })
    fireEvent.click(screen.getByRole("button", { name: "+ Nova conversa" }))
    await within(screen.getByRole("region", { name: "Grupos" })).findByRole("button", {
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
    fireEvent.click(screen.getByRole("button", { name: /^Equipe$/ }))
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
    expect(header.getByText("1 membro", { exact: true })).toBeVisible()
    expect(header.getByRole("img", { name: "1 membro: mark", exact: true })).toBeVisible()
    expect(deleted.querySelector(".tb-avatar")).toHaveAttribute("data-bot-id", "bot-onb")
    expect(row?.querySelector('[data-bot-id="bot-mark"]')).toBeNull()
    expect(row?.querySelector(".message-role")).toHaveTextContent("onb")
    const groupPanel = openGroupPanel("Equipe")
    expect(within(groupPanel).getByText(/mark coordena as respostas/)).toBeVisible()
    expect(within(groupPanel).getByText("Coordenador")).toBeVisible()
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
