import { invoke } from "@tauri-apps/api/core"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { Bot, Run } from "@touri/contracts"
import { useRef, useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { Composer } from "../src/components/Composer"

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => (command === "server_mode_status" ? { mode: "local", url: null } : null)),
  convertFileSrc: (path: string) => path,
}))
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: vi.fn().mockResolvedValue(vi.fn()) }),
}))
afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__")
  vi.clearAllMocks()
})

const setup = ({
  draft = "",
  access = "workspace-write",
  activeRun = null,
  queuedCount = 0,
  hasPendingDelivery = queuedCount > 0,
  browserWorking = false,
  send = vi.fn().mockResolvedValue(undefined),
}: {
  draft?: string
  access?: Bot["access"]
  activeRun?: Run | null
  queuedCount?: number
  hasPendingDelivery?: boolean
  browserWorking?: boolean
  send?: ReturnType<typeof vi.fn>
} = {}) => {
  const api = createMockApi()
  const bot = api.getState().bots[0]
  if (!bot) throw new Error("Bot de QA ausente")
  bot.access = access
  bot.model = "gpt-6.1-sol"
  const cancel = vi.fn().mockResolvedValue(undefined)
  const Harness = ({
    currentRun,
    currentBrowserWorking = browserWorking,
  }: {
    currentRun: Run | null
    currentBrowserWorking?: boolean
  }) => {
    const [text, setText] = useState(draft)
    const input = useRef<HTMLTextAreaElement>(null)
    return (
      <Composer
        bot={bot}
        api={api}
        threadId="thread-mark"
        parentId="parent"
        draft={text}
        onDraft={setText}
        inputRef={input}
        activeRun={currentRun}
        browserWorking={currentBrowserWorking}
        queuedCount={queuedCount}
        hasPendingDelivery={hasPendingDelivery}
        onSend={send}
        onCancel={cancel}
      />
    )
  }
  const view = render(<Harness currentRun={activeRun} />)
  return {
    api,
    send,
    cancel,
    box: screen.getByRole("textbox", { name: "Mensagem para mark" }),
    updateRun: (currentRun: Run | null) => view.rerender(<Harness currentRun={currentRun} />),
    finishBrowser: () => view.rerender(<Harness currentRun={null} currentBrowserWorking={false} />),
  }
}
const run = { id: "active", status: "running" } as Run

describe("composer island", () => {
  it("shows typing before HTTP delivery with a 100 ms response budget", async () => {
    const deliveries = Array.from({ length: 10 }, () => Promise.withResolvers<void>())
    const send = deliveries.reduce((mock, delivery) => mock.mockReturnValueOnce(delivery.promise), vi.fn())
    const { box } = setup({ send })
    const samples = await deliveries.reduce(async (pending, delivery) => {
      const previous = await pending
      fireEvent.change(box, { target: { value: "oi" } })
      await waitFor(() => expect(screen.getByRole("button", { name: "Enviar" })).toBeEnabled())
      const started = performance.now()

      fireEvent.keyDown(box, { key: "Enter", code: "Enter" })

      expect(screen.getByText("mark digitando…")).toBeVisible()
      const elapsed = performance.now() - started
      await act(async () => delivery.resolve())
      expect(screen.queryByText("mark digitando…")).not.toBeInTheDocument()
      return previous.concat(elapsed)
    }, Promise.resolve<number[]>([]))

    expect(samples.toSorted((first, second) => first - second)[8]).toBeLessThan(100)
    expect(Math.max(...samples)).toBeLessThan(500)
    expect(send).toHaveBeenCalledTimes(10)
  })

  it("keeps typing after an optimistic send until the accepted run arrives", async () => {
    const { box, send, updateRun } = setup({ draft: "oi", hasPendingDelivery: true })
    await waitFor(() => expect(screen.getByRole("button", { name: "Enviar" })).toBeEnabled())

    fireEvent.keyDown(box, { key: "Enter" })
    await waitFor(() => expect(send).toHaveBeenCalledOnce())

    expect(screen.getByText("mark digitando…")).toBeVisible()
    updateRun(run)
    expect(screen.queryByText("mark digitando…")).not.toBeInTheDocument()
  })

  it("explicitly accepts common documents and images in the desktop picker and registers each one", async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} })
    const { api } = setup()
    const input = screen.getByLabelText("Anexar arquivos")
    for (const token of [".txt", ".md", ".json", ".csv", ".pdf", "image/*"]) {
      expect(input.getAttribute("accept")?.split(",")).toContain(token)
    }
    const names = ["notas.txt", "plano.md", "dados.json", "tabela.csv", "livro.pdf", "foto.png"]
    fireEvent.change(input, { target: { files: names.map((name) => new File(["arquivo"], name)) } })
    await waitFor(() =>
      expect(api.calls.filter((call) => call.route === "POST /attachments")).toHaveLength(names.length),
    )
    for (const name of names) expect(screen.getByRole("button", { name: `Remover ${name}` })).toBeVisible()
  })

  it("reports the size limit and blocks sending without uploading an oversized file", async () => {
    const { api } = setup({ draft: "Mensagem com anexo" })
    const file = new File(["arquivo"], "grande.pdf")
    Object.defineProperty(file, "size", { value: 15 * 1024 * 1024 + 1 })
    fireEvent.change(screen.getByLabelText("Anexar arquivos"), { target: { files: [file] } })
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível anexar grande.pdf. Escolha um arquivo de até 15 MB",
    )
    expect(api.calls.filter((call) => call.route === "POST /attachments")).toHaveLength(0)
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled()
  })

  it("shows only attachment and send controls, without model or permissions", async () => {
    setup({ access: "read-only" })
    await waitFor(() => expect(screen.queryByText("Colar token manualmente")).toBeNull())
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled()
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Anexar arquivo",
      "Enviar",
    ])
    expect(screen.queryByRole("button", { name: /Escolher modelo|Permissões do bot|Projeto do bot/ })).toBeNull()
    expect(screen.queryByText("gpt-6.1-sol")).toBeNull()
  })

  it("keeps queued plurals", () => {
    setup({ access: "full", queuedCount: 2 })
    expect(screen.queryByRole("button", { name: /Permissões do bot/ })).toBeNull()
    expect(screen.getByRole("status")).toHaveTextContent("2 mensagens na fila")
  })

  it("uses the browser status chip as the single stop control while browser work is active", async () => {
    const { cancel } = setup({ activeRun: run, browserWorking: true })
    const status = screen.getByText("mark está trabalhando · No navegador").closest(".composer-browser-status")

    expect(status).toBeInTheDocument()
    expect(status).toHaveTextContent("No navegador")
    expect(screen.getByRole("button", { name: "Parar mark" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "Stop reply button" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Parar mark" }))
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("active"))
  })

  it("restores composer focus when the focused browser Stop disappears", () => {
    const { box, finishBrowser } = setup({ activeRun: run, browserWorking: true })
    const stop = screen.getByRole("button", { name: "Parar mark" })
    act(() => stop.focus())

    finishBrowser()

    expect(screen.queryByRole("button", { name: "Parar mark" })).toBeNull()
    expect(box).toHaveFocus()
  })

  it("returns focus to the composer before browser Stop becomes disabled", () => {
    const { box, cancel } = setup({ activeRun: run, browserWorking: true })
    const stop = screen.getByRole("button", { name: "Parar mark" })
    act(() => stop.focus())

    fireEvent.click(stop)

    expect(cancel).toHaveBeenCalledWith("active")
    expect(stop).toBeDisabled()
    expect(box).toHaveFocus()
  })

  it("keeps focus on another control when the browser status disappears", () => {
    const { finishBrowser } = setup({ activeRun: run, browserWorking: true })
    const attach = screen.getByRole("button", { name: "Anexar arquivo" })
    act(() => {
      screen.getByRole("button", { name: "Parar mark" }).focus()
      attach.focus()
    })

    finishBrowser()

    expect(screen.queryByRole("button", { name: "Parar mark" })).toBeNull()
    expect(attach).toHaveFocus()
  })

  it("keeps focus on browser Stop when its status only rerenders", () => {
    const { updateRun } = setup({ activeRun: run, browserWorking: true })
    const stop = screen.getByRole("button", { name: "Parar mark" })
    act(() => stop.focus())

    updateRun(Object.assign({}, run, { id: "next-browser-run" }))

    expect(stop).toHaveFocus()
  })

  it("restores focus when Stop disappears before the browser status", () => {
    const { box, updateRun } = setup({ activeRun: run, browserWorking: true })
    const stop = screen.getByRole("button", { name: "Parar mark" })
    act(() => stop.focus())

    updateRun(null)

    expect(screen.getByText("mark está trabalhando · No navegador")).toBeVisible()
    expect(screen.queryByRole("button", { name: "Parar mark" })).toBeNull()
    expect(box).toHaveFocus()
  })

  it("keeps draft attention separate from runtime work (r7 step 67)", async () => {
    const app = render(<App kernel={{ services: { api: createMockApi() } }} />)
    const box = await screen.findByRole("textbox", { name: "Mensagem para mark" })
    fireEvent.focus(box)
    fireEvent.change(box, { target: { value: "Primeira linha\nSegunda linha com acentuação" } })
    await waitFor(() =>
      expect(app.container.querySelector(".chat-bot-chip [data-mascot-state]")).toHaveAttribute(
        "data-mascot-state",
        "listening",
      ),
    )
    expect(app.container.querySelector('.bot-list [data-mascot-state="typing"]')).toBeNull()
  })

  it("stops the run when empty and offers queueing when a draft exists", async () => {
    const { box, cancel, send } = setup({ activeRun: run })
    fireEvent.click(screen.getByRole("button", { name: "Parar" }))
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("active"))
    fireEvent.change(box, { target: { value: "Próxima tarefa" } })
    fireEvent.click(screen.getByRole("button", { name: "Adicionar à fila" }))
    await waitFor(() => expect(send).toHaveBeenCalledWith("Próxima tarefa", "parent", []))
  })

  it("keeps Parando after the cancel acknowledgement, allows typing and queueing, then returns to Enviar", async () => {
    const { box, cancel, send, updateRun } = setup({ activeRun: run })
    fireEvent.click(screen.getByRole("button", { name: "Parar" }))
    expect(screen.getByRole("button", { name: "Parando…" })).toBeDisabled()
    await act(async () => {})
    expect(cancel).toHaveBeenCalledOnce()
    expect(screen.getByRole("button", { name: "Parando…" })).toBeDisabled()
    expect(box).toBeEnabled()
    fireEvent.change(box, { target: { value: "Próxima tarefa" } })
    expect(screen.getByRole("button", { name: "Parando…" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Adicionar à fila" }))
    await waitFor(() => expect(send).toHaveBeenCalledWith("Próxima tarefa", "parent", []))
    expect(screen.getByRole("button", { name: "Parando…" })).toBeDisabled()
    updateRun(null)
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled()
    fireEvent.change(box, { target: { value: "Outro rascunho" } })
    expect(screen.getByRole("button", { name: "Enviar" })).toBeEnabled()
    updateRun({ ...run, id: "next-run" })
    expect(screen.getByRole("button", { name: "Parar" })).toBeEnabled()
  })

  it("preserves a newer draft and prevents duplicate sends while sending", async () => {
    let resolve: (() => void) | undefined
    const send = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done
        }),
    )
    const { box } = setup({ draft: "Primeira mensagem", send })
    await waitFor(() => expect(screen.getByRole("button", { name: "Enviar" })).toBeEnabled())
    fireEvent.keyDown(box, { key: "Enter" })
    fireEvent.keyDown(box, { key: "Enter" })
    expect(send).toHaveBeenCalledOnce()
    fireEvent.change(box, { target: { value: "Rascunho seguinte" } })
    await act(async () => resolve?.())
    expect(box).toHaveValue("Rascunho seguinte")
  })

  it("preserves the draft on failure and allows retry", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("Sem conexão [TOURI-E1008]")).mockResolvedValueOnce(undefined)
    const { box } = setup({ draft: "Não perder este texto", send })
    await waitFor(() => expect(screen.getByRole("button", { name: "Enviar" })).toBeEnabled())
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }))
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("Não consegui conectar à sua IA. Verifique a conexão e tente novamente.")
    const details = screen.getByText("TOURI-E1008").closest(".ds-disclosure")
    expect(details).toHaveAttribute("data-open", "false")
    fireEvent.click(screen.getByRole("button", { name: "Detalhes do erro" }))
    expect(details).toHaveAttribute("data-open", "true")
    expect(box).toHaveValue("Não perder este texto")
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }))
    await waitFor(() => expect(box).toHaveValue(""))
    expect(send).toHaveBeenCalledTimes(2)
  })

  it("registers attachments, removes individual chips, and passes the remaining ids to send", async () => {
    const { api, send } = setup({ draft: "Confira o plano" })
    fireEvent.change(screen.getByLabelText("Anexar arquivos"), {
      target: { files: [new File(["a"], "plano.md"), new File(["b"], "notas.md")] },
    })
    await waitFor(() => expect(screen.getByRole("button", { name: "Enviar" })).toBeEnabled())
    fireEvent.click(screen.getByRole("button", { name: "Remover plano.md" }))
    expect(screen.queryByText("plano.md")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }))
    await waitFor(() => expect(send).toHaveBeenCalledWith("Confira o plano", "parent", ["attachment:/mock/notas.md"]))
    expect(api.calls.filter((call) => call.route === "POST /attachments")).toHaveLength(2)
    await waitFor(() => expect(screen.queryByRole("list", { name: "Arquivos anexados" })).toBeNull())
  })

  it("supports attachments alone with a readable message", async () => {
    const { send } = setup()
    fireEvent.change(screen.getByLabelText("Anexar arquivos"), { target: { files: [new File(["a"], "plano.md")] } })
    await waitFor(() => expect(screen.getByRole("button", { name: "Enviar" })).toBeEnabled())
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }))
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith("Confira os arquivos anexados.", "parent", ["attachment:/mock/plano.md"]),
    )
  })

  it("blocks sending after attachment failure until the failed file is removed", async () => {
    const { api } = setup({ draft: "Texto seguro" })
    vi.spyOn(api, "request").mockRejectedValueOnce(new Error("Arquivo indisponível"))
    fireEvent.change(screen.getByLabelText("Anexar arquivos"), { target: { files: [new File(["a"], "plano.md")] } })
    await screen.findByRole("alert")
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Remover plano.md" }))
    expect(screen.getByRole("button", { name: "Enviar" })).toBeEnabled()
  })

  it("uses the WebView file chooser in the desktop shell", async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} })
    const { api } = setup()
    const input = screen.getByLabelText("Anexar arquivos")
    const clicked = vi.spyOn(input, "click")
    fireEvent.click(screen.getByRole("button", { name: "Anexar arquivo" }))
    expect(clicked).toHaveBeenCalledOnce()
    fireEvent.change(input, { target: { files: [new File(["a"], "plano.md")] } })
    await waitFor(() => expect(api.calls.some((call) => call.route === "POST /attachments")).toBe(true))
    expect(invoke).toHaveBeenCalledWith("server_mode_status", {})
    expect(vi.mocked(invoke).mock.calls.every(([command]) => command === "server_mode_status")).toBe(true)
  })
})
