import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { Message } from "@touri/contracts"
import { describe, expect, it } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { latestPreview } from "../src/botPreview"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { composerKeyAction } from "../src/composerKeys"
import { runErrorFor } from "../src/runError"

const key = (overrides: Partial<Parameters<typeof composerKeyAction>[0]>): Parameters<typeof composerKeyAction>[0] => ({
  key: "Enter",
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  isComposing: false,
  keyCode: 13,
  ...overrides,
})

const message = (overrides: Partial<Message>): Message => ({
  id: "m",
  threadId: "t1",
  parentId: null,
  role: "assistant",
  kind: "text",
  status: "complete",
  runId: null,
  text: "",
  parts: [],
  sender: null,
  source: "local",
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

describe("tool screenshots", () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="
  const renderResult = (data: string, mimeType = "image/png") =>
    render(
      <VirtualMessageList
        messages={[
          message({
            parts: [
              {
                type: "tool_call",
                callId: "capture",
                tool: "computer_screenshot",
                summary: "",
                inputJson: '{"maxWidth":1440}',
                outputJson: JSON.stringify({
                  success: true,
                  content: [
                    { type: "text", text: "Display da VM" },
                    { type: "image", data, mimeType },
                  ],
                  structured: { width: 1440, height: 900 },
                }),
                ok: true,
              },
            ],
          }),
        ]}
        onSwitchBranch={async () => {}}
        onRetry={async () => {}}
      />,
    )
  it.each([png, `data:image/png;base64,${png}`])(
    "renders a screenshot thumbnail, opens it and offers a download",
    (data) => {
      renderResult(data)
      fireEvent.click(screen.getByRole("button", { name: /1 ação/ }))
      fireEvent.click(screen.getByText("Resultado", { selector: "summary" }))
      const output = screen.getByText(/Display da VM/, { selector: "code" })
      expect(output).toHaveTextContent("Display da VM")
      expect(output).not.toHaveTextContent(png)
      expect(output.textContent).toContain('{\n  "width": 1440,\n  "height": 900\n}')
      HTMLDialogElement.prototype.showModal = function () {
        this.setAttribute("open", "")
      }
      HTMLDialogElement.prototype.close = function () {
        this.removeAttribute("open")
      }
      fireEvent.click(screen.getByRole("button", { name: "Abrir captura 1 em tamanho original" }))
      expect(screen.getByRole("dialog", { name: "Captura de tela da ferramenta" })).toBeVisible()
      expect(screen.getByRole("button", { name: "Baixar imagem" })).toBeVisible()
      expect(screen.queryByRole("link", { name: "Baixar imagem" })).toBeNull()
    },
  )
  it("does not render executable image formats or dump their payload into text", () => {
    renderResult("PHN2Zz48c2NyaXB0Pjwvc2NyaXB0Pjwvc3ZnPg==", "image/svg+xml")
    fireEvent.click(screen.getByRole("button", { name: /1 ação/ }))
    expect(screen.queryByAltText("Captura de tela da ferramenta")).not.toBeInTheDocument()
    expect(document.body).not.toHaveTextContent("PHN2Zz48c2NyaXB0Pjwvc2NyaXB0Pjwvc3ZnPg==")
  })
})

describe("composer keyboard", () => {
  it("sends on Enter and Cmd/Ctrl+Enter, newline on Shift+Enter", () => {
    expect(composerKeyAction(key({}))).toBe("send")
    expect(composerKeyAction(key({ metaKey: true }))).toBe("send")
    expect(composerKeyAction(key({ ctrlKey: true }))).toBe("send")
    expect(composerKeyAction(key({ shiftKey: true }))).toBe("newline")
    expect(composerKeyAction(key({ key: "a" }))).toBe("none")
  })

  it("ignores Enter during IME composition", () => {
    expect(composerKeyAction(key({ isComposing: true }))).toBe("none")
    expect(composerKeyAction(key({ keyCode: 229 }))).toBe("none")
  })

  it("pressing Enter in the textarea sends the draft and Shift+Enter does not", async () => {
    render(<App kernel={{ services: { api: createMockApi() } }} />)
    const box = await screen.findByRole("textbox", { name: "Mensagem para mark" })
    fireEvent.change(box, { target: { value: "ola" } })
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true })
    expect((box as HTMLTextAreaElement).value).toBe("ola")
    fireEvent.keyDown(box, { key: "Enter" })
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(""))
  })

  it("Cmd+Enter also sends", async () => {
    render(<App kernel={{ services: { api: createMockApi() } }} />)
    const box = await screen.findByRole("textbox", { name: "Mensagem para mark" })
    fireEvent.change(box, { target: { value: "oi" } })
    fireEvent.keyDown(box, { key: "Enter", metaKey: true })
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(""))
  })
})

it("shows the active bot name once while keeping bot navigation visible", async () => {
  render(<App kernel={{ services: { api: createMockApi() } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })

  const heading = screen.getByRole("heading", { level: 1, name: "mark" })
  const header = heading.closest("header")
  if (!header) throw new Error("Missing chat header")
  const botName = heading.textContent ?? ""
  const botNameAppearances = botName ? (header.textContent?.split(botName).length ?? 1) - 1 : 0

  expect(botNameAppearances).toBe(1)
  expect(within(header).getByText("Bots")).toBeVisible()
  const sidebar = screen.getByRole("navigation", { name: "Barra lateral" })
  expect(within(sidebar).getByRole("button", { name: /Bots/ })).toBeVisible()
})

describe("bot preview", () => {
  it("uses the latest message with readable text across threads", () => {
    const messages = [
      message({ id: "a", threadId: "t1", text: "primeira", createdAt: 1 }),
      message({ id: "b", threadId: "t2", text: "mais recente\ncom quebra", createdAt: 5 }),
      message({ id: "c", threadId: "t1", createdAt: 9, parts: [] }),
      message({ id: "d", threadId: "other", text: "de outro bot", createdAt: 10 }),
    ]
    expect(latestPreview({ threadIds: ["t1", "t2"], messages })).toBe("mais recente com quebra")
    expect(latestPreview({ threadIds: ["none"], messages })).toBe("")
  })

  it("falls back to the error notice of a failed reply", () => {
    const failed = message({
      status: "failed",
      createdAt: 9,
      parts: [{ type: "notice", level: "error", code: "run_failed", text: "cli_missing: ENOENT" }],
    })
    expect(latestPreview({ threadIds: ["t1"], messages: [failed] })).toBe("Não encontrei o programa do provedor")
  })
})

describe("failed turns", () => {
  const failed = message({
    id: "f",
    status: "failed",
    runId: "run-1",
    parts: [{ type: "notice", level: "error", code: "run_failed", text: "cli_missing: ENOENT spawn codex" }],
  })

  it("maps the error class to a readable title and a safe detail", () => {
    expect(runErrorFor(failed)).toMatchObject({
      title: "Não encontrei o programa do provedor",
      detail: "O programa Codex não foi encontrado neste computador.",
    })
    expect(runErrorFor(message({}))).toBeNull()
  })

  it("renders an inline error with a working Retry button", () => {
    const retried: Array<string> = []
    render(
      <VirtualMessageList
        messages={[failed]}
        onSwitchBranch={() => undefined}
        onRetry={async (runId) => {
          retried.push(runId)
        }}
      />,
    )
    expect(screen.getByRole("alert")).toHaveTextContent("Não encontrei o programa do provedor")
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }))
    expect(retried).toEqual(["run-1"])
  })
})

describe("window chrome", () => {
  it("draws fake traffic lights only for the mock adapter", async () => {
    const real = render(<App kernel={{ services: { api: { ...createMockApi(), isMock: false } } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    expect(real.container.querySelector(".traffic-light")).toBeNull()
    real.unmount()
    const mock = render(<App kernel={{ services: { api: createMockApi() } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    expect(mock.container.querySelector(".traffic-light")).not.toBeNull()
  })

  it("keeps model information in bot details, reached from the chat", async () => {
    render(<App kernel={{ services: { api: createMockApi() } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    expect(document.querySelector(".model-pill")).toBeNull()
    expect(screen.queryByRole("button", { name: /^Modelo:/ })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Painel do bot" }))
    expect(screen.getByRole("button", { name: /^Modelo: Codex ·/ })).toBeVisible()
  })
})
