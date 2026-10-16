import { act, fireEvent, render, screen, within } from "@testing-library/react"
import type { Message } from "@touri/contracts"
import { describe, expect, it } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"

describe("Grupos", () => {
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
  it("shows each reply's member mascot/name and lists memberships in Detalhes", async () => {
    const api = createMockApi()
    const created = await api.request("POST /groups", {
      name: "Equipe",
      color: "#dc2626",
      avatarShape: "cercle",
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
