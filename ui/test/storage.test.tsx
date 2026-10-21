import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ApiRoutes, ToolCallPart } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { ToolCallCard } from "../src/components/ToolCallCard"
import { DoctorStorage } from "../src/features/doctor/DoctorStorage"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
const part: ToolCallPart = {
  type: "tool_call",
  callId: "call",
  tool: "computer.screenshot",
  summary: "Captura",
  inputJson: "{}",
  outputJson: null,
  outputAttachmentId: "blob",
  outputBytes: 80_000,
  ok: true,
  resolution: "succeeded",
}

it("loads file-backed tool results only on demand through authenticated attachment requests", async () => {
  const base = createMockApi()
  const output = vi.fn(async () => ({
    text: JSON.stringify({ dataBase64: "aW1hZ2U=", mime: "image/png" }),
    offset: 0,
    nextOffset: null,
    bytes: 48,
  }))
  const request: ApiRequest = async (route, input, path) =>
    route === "GET /attachments/:id/content" ? (output() as never) : base.request(route, input, path)
  render(<ToolCallCard part={part} api={{ ...base, request }} />)
  expect(output).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Abrir resultado completo" }))
  expect(await screen.findByRole("button", { name: "Baixar imagem" })).toBeVisible()
  expect(output).toHaveBeenCalledOnce()
})

it.each([undefined, ""])(
  "opens a large stored image in bounded pages without rendering partial base64 (preview %s)",
  async (outputPreview) => {
    const base = createMockApi()
    const text = JSON.stringify({ dataBase64: "a".repeat(90_000), mime: "image/png" })
    const pageSize = 64 * 1024
    const tail = { text: text.slice(pageSize), offset: pageSize, nextOffset: null, bytes: text.length }
    let release = () => {}
    const pending = new Promise<typeof tail>((resolve) => {
      release = () => resolve(tail)
    })
    const pages = vi
      .fn()
      .mockResolvedValueOnce({ text: text.slice(0, pageSize), offset: 0, nextOffset: pageSize, bytes: text.length })
      .mockReturnValueOnce(pending)
    const request: ApiRequest = async (route, input, path) =>
      route === "GET /attachments/:id/content" ? pages(input, path) : base.request(route, input, path)
    const view = render(
      <ToolCallCard
        part={{ ...part, ...(outputPreview === undefined ? {} : { outputPreview }) }}
        api={{ ...base, request }}
      />,
    )
    expect(pages).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Abrir resultado completo" }))
    await waitFor(() => expect(pages).toHaveBeenCalledTimes(2))
    expect(screen.getByRole("button", { name: "Carregando resultado…" })).toBeDisabled()
    expect(view.container.querySelector(".tool-output")).toBeNull()
    expect(screen.queryByText(/dataBase64/)).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Carregar mais saída" })).not.toBeInTheDocument()
    release()
    expect(await screen.findByRole("button", { name: "Baixar imagem" })).toBeVisible()
    expect(pages.mock.calls).toEqual([
      [{ offset: 0, limit: pageSize }, { id: "blob" }],
      [{ offset: pageSize, limit: pageSize }, { id: "blob" }],
    ])
    expect(screen.queryByText(/dataBase64/)).not.toBeInTheDocument()
  },
)

it("stops large image opens at the bounded envelope limit", async () => {
  const base = createMockApi()
  const pages = vi.fn(async () => ({
    text: '{"dataBase64":"aaaa',
    offset: 0,
    nextOffset: 65536,
    bytes: 20 * 1024 * 1024 + 1,
  }))
  const request: ApiRequest = async (route, input, path) =>
    route === "GET /attachments/:id/content" ? (pages() as never) : base.request(route, input, path)
  const view = render(<ToolCallCard part={{ ...part, outputPreview: "" }} api={{ ...base, request }} />)
  fireEvent.click(screen.getByRole("button", { name: "Abrir resultado completo" }))
  expect(await screen.findByText("Esta imagem é grande demais para abrir aqui.")).toBeVisible()
  expect(pages).toHaveBeenCalledOnce()
  expect(view.container.querySelector(".tool-output")).toBeNull()
  expect(screen.queryByText(/dataBase64/)).not.toBeInTheDocument()
})

it("retries attachment errors and clears old output when a newer reference arrives", async () => {
  const base = createMockApi()
  const output = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ text: "Resposta completa", offset: 0, nextOffset: null, bytes: 17 })
  const request: ApiRequest = async (route, input, path) =>
    route === "GET /attachments/:id/content" ? output() : base.request(route, input, path)
  const api = { ...base, request }
  const view = render(<ToolCallCard part={part} api={api} />)
  fireEvent.click(screen.getByRole("button", { name: "Abrir resultado completo" }))
  expect(await screen.findByText(/Não foi possível abrir o resultado/)).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Abrir resultado completo" }))
  expect(await screen.findByText("Resposta completa")).toBeInTheDocument()
  view.rerender(<ToolCallCard part={{ ...part, outputAttachmentId: "new" }} api={api} />)
  expect(screen.queryByText("Resposta completa")).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Abrir resultado completo" })).toBeEnabled()
})

it("Doctor reports storage sources, polls chunk progress, and requests VACUUM only when selected", async () => {
  vi.useFakeTimers()
  const base = createMockApi()
  const report: ApiRoutes["GET /doctor/storage"]["res"] = {
    storage: {
      databaseBytes: 48 * 1024 ** 2,
      walBytes: 0,
      reusableBytes: 1024 ** 2,
      messageTextBytes: 1024 ** 2,
      messagePartsBytes: 2 * 1024 ** 2,
      transcriptBytes: 3 * 1024 ** 2,
      eventBytes: 4 * 1024 ** 2,
      attachmentBytes: 5 * 1024 ** 2,
      turns: 10,
    },
    maintenance: { running: false, processed: 0, total: 100 },
  }
  const compact = vi.fn((input: unknown) => {
    report.maintenance = { running: true, processed: 50, total: 100 }
    return { maintenance: report.maintenance, input }
  })
  const request: ApiRequest = async (route, input, path) =>
    route === "GET /doctor/storage"
      ? (structuredClone(report) as never)
      : route === "POST /doctor/storage/compact"
        ? (compact(input) as never)
        : base.request(route, input, path)
  await act(async () => render(<DoctorStorage api={{ ...base, request }} />))
  expect(screen.getByText(/Banco: 48 MB/)).toBeVisible()
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Compactar dados" })))
  expect(compact).toHaveBeenLastCalledWith({ vacuum: false })
  expect(screen.getByRole("button", { name: "Compactando dados…" })).toBeDisabled()
  expect(screen.getByRole("status")).toHaveTextContent("50 de 100")
  report.maintenance = { running: false, processed: 100, total: 100 }
  await act(async () => vi.advanceTimersByTimeAsync(1000))
  fireEvent.click(screen.getByRole("checkbox", { name: "Recuperar espaço do banco (VACUUM)" }))
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Compactar dados" })))
  expect(compact).toHaveBeenLastCalledWith({ vacuum: true })
})

it("Doctor lets the user retry a rejected compaction", async () => {
  const base = createMockApi()
  const request: ApiRequest = async (route, input, path) => {
    if (route === "POST /doctor/storage/compact") throw new Error("busy")
    return base.request(route, input, path)
  }
  render(<DoctorStorage api={{ ...base, request }} />)
  await waitFor(() => expect(screen.getByText(/Banco:/)).toBeVisible())
  fireEvent.click(screen.getByRole("button", { name: "Compactar dados" }))
  expect(await screen.findByText(/Não foi possível iniciar a compactação/)).toBeVisible()
  expect(screen.getByRole("button", { name: "Compactar dados" })).toBeEnabled()
})

it("Doctor labels the write-ahead log in plain language without Diário in pt-BR and translates in English", async () => {
  const { t } = await import("../src/i18n")
  const base = createMockApi()
  render(<DoctorStorage api={base} />)
  expect(await screen.findByText(/Banco:.*· Registro temporário do banco:.*· Espaço reutilizável:/)).toBeVisible()
  expect(screen.queryByText(/Diário/)).toBeNull()
  expect(t("Registro temporário do banco", {}, "pt-BR")).toBe("Registro temporário do banco")
  expect(t("Registro temporário do banco", {}, "en")).toBe("Temporary database log")
})

it("renders a file-backed diff literally after loading its attachment", async () => {
  const base = createMockApi()
  const diff = "diff --git a/README.md b/README.md\n@@ -1 +1 @@\n+```js\n+<b>literal</b>\n+``````"
  const request: ApiRequest = async (route, input, path) =>
    route === "GET /attachments/:id/content"
      ? ({ text: diff, offset: 0, nextOffset: null, bytes: diff.length } as never)
      : base.request(route, input, path)
  const view = render(
    <ToolCallCard
      api={{ ...base, request }}
      part={{
        type: "file_change",
        callId: "edit",
        paths: ["README.md"],
        diff: null,
        outputAttachmentId: "diff-blob",
        resolution: "succeeded",
      }}
    />,
  )
  fireEvent.click(screen.getByRole("button", { name: "Abrir resultado completo" }))
  await waitFor(() => expect(view.container.querySelector(".tool-output pre code")?.textContent).toBe(diff))
  expect(view.container.querySelector("b")).toBeNull()
})

it("keeps browser page context and host screenshot thumbnails when output is stored as an attachment", async () => {
  const base = createMockApi()
  const request: ApiRequest = async (route, input, path) =>
    route === "GET /attachments/:id/content"
      ? ({
          text: JSON.stringify({
            structured: {
              title: "Página preservada",
              url: "https://example.org/pagina",
              dataUrl: "data:image/png;base64,aW1hZ2U=",
            },
            content: [],
          }),
          offset: 0,
          nextOffset: null,
          bytes: 200,
        } as never)
      : base.request(route, input, path)
  render(<ToolCallCard part={{ ...part, tool: "mcp__touri__browser_screenshot" }} api={{ ...base, request }} />)
  expect(screen.getByRole("article")).toHaveAccessibleName("Ferramenta · Captura")
  expect(screen.queryByText("Página preservada")).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Abrir resultado completo" }))
  expect(await screen.findByText("Página preservada")).toBeVisible()
  expect(screen.getByText("https://example.org")).toBeVisible()
  expect(document.body.textContent).not.toContain("/pagina")
  expect(screen.getByRole("button", { name: "Baixar imagem" })).toBeVisible()
  expect(screen.queryByText("Resultado")).toBeNull()
})

it("shows the inline preview and reads large output only in explicit bounded pages", async () => {
  const base = createMockApi()
  const pages = vi
    .fn()
    .mockResolvedValueOnce({ text: "Primeira página.\n", offset: 0, nextOffset: 19, bytes: 40 })
    .mockResolvedValueOnce({ text: "Última página.", offset: 19, nextOffset: null, bytes: 40 })
  const request: ApiRequest = async (route, input, path) =>
    route === "GET /attachments/:id/content" ? pages(input, path) : base.request(route, input, path)
  render(<ToolCallCard part={{ ...part, outputPreview: "Prévia preservada" }} api={{ ...base, request }} />)
  expect(screen.getByText("Prévia preservada")).toBeInTheDocument()
  expect(pages).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Abrir resultado completo" }))
  expect(await screen.findByText("Primeira página.")).toBeInTheDocument()
  expect(pages).toHaveBeenLastCalledWith({ offset: 0, limit: 65536 }, { id: "blob" })
  expect(pages).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole("button", { name: "Carregar mais saída" }))
  await waitFor(() => expect(screen.getByText(/Última página/)).toBeInTheDocument())
  expect(pages).toHaveBeenLastCalledWith({ offset: 19, limit: 65536 }, { id: "blob" })
  expect(screen.queryByRole("button", { name: "Carregar mais saída" })).not.toBeInTheDocument()
})
