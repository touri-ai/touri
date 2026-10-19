import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Message } from "@touri/contracts"
import { describe, expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { ChatPanel, VirtualMessageList } from "../src/components/ChatPanel"
import { saveBlob } from "../src/saveFile"

vi.mock("../src/saveFile", () => ({
  saveBlob: vi.fn(async () => ({ status: "saved", path: "/downloads/anexo" })),
  saveNoticeText: (outcome: { status: string; path: string }) => `Salvo em ${outcome.path}`,
}))

const message = (overrides: Partial<Message> = {}): Message => ({
  id: "question",
  threadId: "thread-mark",
  parentId: null,
  role: "user",
  kind: "text",
  status: "complete",
  runId: null,
  text: "Pergunta original",
  parts: [{ type: "text", text: "Pergunta original" }],
  sender: null,
  source: "local",
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})
const attached = [
  { type: "file", attachmentId: "text-id", name: "teste-anexo.txt", mime: "application/octet-stream" },
  { type: "image", attachmentId: "image-id", name: "teste-imagem.png", mime: "image/png" },
] satisfies Message["parts"]

describe("sent attachments", () => {
  it("keeps names and authenticated downloads after history is remounted, including old unnamed images", async () => {
    const api = createMockApi()
    const contents = new Blob(["conteúdo enviado"], { type: "text/plain" })
    const request = vi.spyOn(api, "request").mockResolvedValue(contents as never)
    const props = {
      messages: [message({ parts: [...attached, { type: "image", attachmentId: "old-image", mime: "image/png" }] })],
      api,
      onSwitchBranch: vi.fn(),
      onRetry: vi.fn(),
    }
    const first = render(<VirtualMessageList {...props} />)
    first.unmount()
    render(<VirtualMessageList {...props} />)
    const list = screen.getByRole("list", { name: "Arquivos enviados" })
    expect(list).toHaveTextContent("teste-anexo.txt")
    expect(list).toHaveTextContent("teste-imagem.png")
    expect(list).toHaveTextContent("Imagem anexada")
    for (const [name, id] of [
      ["teste-anexo.txt", "text-id"],
      ["teste-imagem.png", "image-id"],
    ]) {
      fireEvent.click(within(list).getByRole("button", { name: `Baixar ${name}` }))
      await waitFor(() => expect(saveBlob).toHaveBeenCalledWith(contents, name))
      expect(request).toHaveBeenCalledWith("GET /attachments/:id", {}, { id })
      await waitFor(() => expect(within(list).getByRole("button", { name: `Baixar ${name}` })).toBeEnabled())
    }
    expect(screen.getByRole("status")).toHaveTextContent("Salvo em /downloads/anexo")
  })
})

describe("user prompt editing", () => {
  it("withholds edits in flat group history while keeping every member's reply visible", async () => {
    const api = createMockApi()
    const bot = api.getState().bots[0]
    if (!bot) throw new Error("Missing fixture")
    const { group, thread } = await api.request("POST /groups", {
      name: "Equipe QA",
      color: "#dc2626",
      avatarShape: "classic-none",
      memberIds: ["bot-mark", "bot-onb"],
      coordinatorBotId: null,
    })
    const question = message({ threadId: thread.id })
    const replies = ["mark", "onb"].map((name, index) =>
      message({
        id: `reply-${name}`,
        threadId: thread.id,
        parentId: question.id,
        role: "assistant",
        text: `Resposta de ${name}`,
        parts: [],
        sender: { id: `bot-${name}`, name },
        createdAt: index + 2,
      }),
    )
    const send = vi.fn(async () => {})
    render(
      <ChatPanel
        group={group}
        groupMembers={api.getState().bots.filter((bot) => group.memberIds.includes(bot.id))}
        thread={{ ...thread, activeLeafId: replies[1]?.id ?? null }}
        bot={bot}
        messages={[question, ...replies]}
        runs={[]}
        onSend={send}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
        onSwitchBranch={vi.fn()}
        computerGrant={null}
        api={api}
        onComputerGrant={vi.fn()}
        onOpenTools={vi.fn()}
      />,
    )
    expect(screen.getByText("Pergunta original")).toBeVisible()
    expect(screen.getByText("Resposta de mark")).toBeVisible()
    expect(screen.getByText("Resposta de onb")).toBeVisible()
    expect(screen.queryByRole("button", { name: "Editar", exact: true })).toBeNull()
    expect(screen.queryByRole("textbox", { name: "Editar mensagem" })).toBeNull()
    expect(send).not.toHaveBeenCalled()
  })

  it.each([null, "parent"])("creates a sibling branch from parent %s and preserves attachments", async (parentId) => {
    const api = createMockApi()
    const bot = api.getState().bots[0]
    const thread = api.getState().threads.find((thread) => thread.id === "thread-mark")
    if (!bot || !thread) throw new Error("Missing fixture")
    const question = message({ parentId, parts: [{ type: "text", text: "Pergunta original" }, ...attached] })
    const reply = message({
      id: "reply",
      parentId: question.id,
      role: "assistant",
      text: "Resposta original",
      parts: [],
      createdAt: 2,
    })
    const messages = [
      ...(parentId
        ? [message({ id: parentId, role: "assistant", text: "Contexto anterior", parts: [], createdAt: 0 })]
        : []),
      question,
      reply,
    ]
    const send = vi.fn(async () => {})
    const switchBranch = vi.fn(async () => {})
    const props = {
      thread: { ...thread, activeLeafId: reply.id },
      bot,
      messages,
      runs: [],
      onSend: send,
      onRetry: vi.fn(),
      onCancel: vi.fn(),
      onSwitchBranch: switchBranch,
      computerGrant: null,
      api,
      onComputerGrant: vi.fn(),
      onOpenTools: vi.fn(),
    }
    const view = render(<ChatPanel {...props} />)
    const user = userEvent.setup()
    screen.getByRole("button", { name: "Editar" }).focus()
    await user.keyboard("{Enter}")
    const editor = screen.getByRole("textbox", { name: "Editar mensagem" })
    expect(editor).toHaveFocus()
    expect(editor).toHaveValue("Pergunta original")
    fireEvent.change(editor, { target: { value: "Pergunta corrigida" } })
    fireEvent.keyDown(editor, { key: "Enter", isComposing: true })
    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true })
    expect(send).not.toHaveBeenCalled()
    await user.keyboard("{Control>}{Enter}{/Control}")
    await waitFor(() => expect(send).toHaveBeenCalledWith("Pergunta corrigida", parentId, ["text-id", "image-id"]))
    const edited = message({
      ...question,
      id: "edited",
      text: "Pergunta corrigida",
      parts: [{ type: "text", text: "Pergunta corrigida" }, ...attached],
      createdAt: 3,
    })
    view.rerender(
      <ChatPanel {...props} messages={[...messages, edited]} thread={{ ...thread, activeLeafId: edited.id }} />,
    )
    expect(screen.getByText("2/2")).toBeVisible()
    expect(screen.queryByText("Resposta original")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Ramificação anterior" }))
    expect(switchBranch).toHaveBeenCalledWith(thread.id, question.id)
    view.rerender(<ChatPanel {...props} messages={[...messages, edited]} />)
    expect(screen.getByText("1/2")).toBeVisible()
    expect(await screen.findByText("Resposta original")).toBeVisible()
    expect(question.text).toBe("Pergunta original")
  })

  it("keeps failed edits for retry and lets Escape cancel without sending", async () => {
    const edit = vi.fn().mockRejectedValueOnce(new Error("Sem conexão")).mockResolvedValueOnce(undefined)
    render(<VirtualMessageList messages={[message()]} onEdit={edit} onSwitchBranch={vi.fn()} onRetry={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Editar" }))
    const editor = screen.getByRole("textbox", { name: "Editar mensagem" })
    fireEvent.change(editor, { target: { value: "Rascunho corrigido" } })
    fireEvent.click(screen.getByRole("button", { name: "Salvar e enviar" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Sem conexão")
    expect(editor).toHaveValue("Rascunho corrigido")
    fireEvent.keyDown(editor, { key: "Escape" })
    expect(screen.queryByRole("textbox", { name: "Editar mensagem" })).toBeNull()
    expect(screen.getByRole("button", { name: "Editar" })).toHaveFocus()
    expect(edit).toHaveBeenCalledOnce()
  })
})
