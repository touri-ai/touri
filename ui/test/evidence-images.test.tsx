import { Blob as NodeBlob } from "node:buffer"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { BotLibrary } from "../src/components/BotLibrary"
import { EvidenceContext, type EvidenceContextValue, EvidenceGallery } from "../src/components/EvidenceGallery"
import { evidencePath } from "../src/components/evidenceMarkdown"
import { getThumbnailSize, imageDimensions, loadImage, thumbnailBlob } from "../src/components/imageLoads"
import { MarkdownContent } from "../src/components/MarkdownContent"
import { ToolOutput } from "../src/components/ToolOutput"
import { ApiError } from "../src/errors"

const { saveInvoke } = vi.hoisted(() => ({
  saveInvoke: vi.fn(async (_command: string, _args: unknown) => ({ path: "/tmp/shot-1.png" })),
}))
vi.mock("@tauri-apps/api/core", () => ({ invoke: saveInvoke }))
const blob = new NodeBlob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" }) as unknown as Blob
const createUrl = vi.fn(() => `blob:fixture-${Math.random()}`)
const revokeUrl = vi.fn()
const bitmapClose = vi.fn()
beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} })
  saveInvoke.mockClear()
  vi.stubGlobal("Blob", NodeBlob)
  vi.stubGlobal("PointerEvent", MouseEvent)
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  )
  HTMLElement.prototype.setPointerCapture = vi.fn()
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 480, height: 320, close: bitmapClose })),
  )
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ blob: async () => blob })),
  )
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createUrl })
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeUrl })
  Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
    configurable: true,
    value: (callback: (blob: Blob) => void) => callback(blob),
  })
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "")
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open")
  }
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
const fixture = () => {
  const api = createMockApi()
  const bot = api.getState().bots[0]
  if (!bot) throw new Error("Missing fixture")
  const request = vi.fn(async (..._args: unknown[]) => blob)
  const context: EvidenceContextValue = {
    api: { ...api, request: request as never },
    bot: { ...bot, machine: "vm" },
    onComputer: vi.fn(),
    onLibrary: vi.fn(),
  }
  return { context, request }
}

describe("safe markdown evidence", () => {
  it("keeps planned filenames plain until the authenticated image read succeeds", async () => {
    const { context, request } = fixture()
    let finish: ((value: Blob) => void) | undefined
    request.mockImplementationOnce(
      () =>
        new Promise<Blob>((resolve) => {
          finish = resolve
        }),
    )
    request.mockRejectedValueOnce(new ApiError(404, "Arquivo não encontrado"))
    const view = render(
      <MarkdownContent evidence={context} content="Vou criar `post-01.png` e ![Post 2](post-02.png)." />,
    )
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole("button", { name: /Abrir captura/ })).toBeNull()
    expect(view.container.querySelector("figure, img")).toBeNull()
    expect(screen.queryByText(/Prévia indisponível|Tentar novamente|Carregando imagem/)).toBeNull()
    expect(screen.getByText("post-01.png", { selector: "code" })).toBeVisible()
    await act(async () => finish?.(blob))
    expect(await screen.findByRole("img", { name: "post-01.png" })).toBeVisible()
    expect(screen.getAllByRole("button", { name: /Abrir captura/ })).toHaveLength(1)
  })

  it("downloads Markdown image links through the authenticated endpoint without local-path navigation", async () => {
    const { context, request } = fixture()
    render(<MarkdownContent evidence={context} content="[Baixar imagem 1 — PNG](/output/post-01.png)" />)
    const download = await screen.findByRole("button", { name: "Baixar imagem 1 — PNG" })
    expect(screen.queryByRole("link", { name: "Baixar imagem 1 — PNG" })).toBeNull()
    fireEvent.click(download)
    await waitFor(() =>
      expect(saveInvoke).toHaveBeenCalledWith("save_file", expect.objectContaining({ name: "post-01.png" })),
    )
    expect(request).toHaveBeenCalledWith(
      "GET /bots/:id/images",
      { path: "/output/post-01.png" },
      { id: context.bot.id },
    )
  })
  it("uses the image caption when its download link appears first", async () => {
    const { context } = fixture()
    const view = render(
      <MarkdownContent
        evidence={context}
        content={"[Baixar imagem](/workspace/mobile.png)\n\n![mobile](/workspace/mobile.png)"}
      />,
    )

    const gallery = await screen.findByRole("region", { name: "Imagens de evidência" })
    const card = gallery.querySelector("figure")

    expect(card).toHaveTextContent("mobile")
    expect(screen.getAllByRole("button", { name: "Baixar imagem" })).toHaveLength(1)
    expect(screen.getAllByRole("button", { name: /Abrir captura/ })).toHaveLength(1)
    expect(view.container.querySelectorAll(".markdown-content > p:not(:empty)")).toHaveLength(0)
  })
  it.each(["Salvei a captura em [tela.png](/workspace/tela.png).", "[tela.png](/workspace/tela.png)"])(
    "preserves image link text in prose: %s",
    async (prose) => {
      const { context } = fixture()
      const view = render(<MarkdownContent evidence={context} content={`${prose}\n\n![tela](/workspace/tela.png)`} />)

      await screen.findByRole("region", { name: "Imagens de evidência" })

      expect(screen.getByRole("button", { name: "tela.png" })).toBeVisible()
      expect(view.container.querySelector(".markdown-content > p")).toHaveTextContent(
        prose.startsWith("Salvei") ? "Salvei a captura em tela.png." : "tela.png",
      )
    },
  )
  it("rechecks a missing image after the bot finishes producing it", async () => {
    const api = createMockApi()
    const { context, request } = fixture()
    request.mockRejectedValueOnce(new ApiError(404, "Arquivo não encontrado"))
    const value = { ...context, api: { ...api, request: request as never } }
    render(<MarkdownContent evidence={value} content="Vou criar `post-01.png`." />)
    await waitFor(() => expect(request).toHaveBeenCalledOnce())
    expect(screen.queryByRole("img")).toBeNull()
    const { runs } = await api.request("GET /workspace/activity", {})
    const run = runs[0]
    if (!run) throw new Error("Missing run fixture")
    act(() => api.emit({ type: "run.updated", run: { ...run, botId: value.bot.id, finishedAt: 1 } }))
    expect(await screen.findByRole("img", { name: "post-01.png" })).toBeVisible()
    expect(request).toHaveBeenCalledTimes(2)
  })
  it("previews and downloads generic file links using the report directory and shows read errors", async () => {
    const { context, request } = fixture()
    request.mockResolvedValueOnce({ name: "report.pdf", mime: "application/pdf", base64: btoa("File bytes") } as never)
    request.mockRejectedValueOnce(new ApiError(403, "Pasta não autorizada"))
    render(<MarkdownContent evidence={{ ...context, base: "/output" }} content="[Baixar relatório](report.pdf)" />)
    const button = await screen.findByRole("button", { name: "Baixar relatório" })
    fireEvent.click(button)
    expect(await screen.findByRole("dialog", { name: "report.pdf" })).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Baixar arquivo" }))
    await waitFor(() =>
      expect(saveInvoke).toHaveBeenCalledWith("save_file", { name: "report.pdf", dataBase64: btoa("File bytes") }),
    )
    expect(request).toHaveBeenCalledWith(
      "GET /bots/:id/files/content",
      { path: "/output/report.pdf" },
      { id: context.bot.id },
    )
    fireEvent.click(screen.getByRole("button", { name: "Fechar arquivo" }))
    fireEvent.click(button)
    expect(await screen.findByRole("alert")).toHaveTextContent("pastas permitidas")
  })
  it("keeps generic file previews and authenticated image downloads together in the same message", async () => {
    const { context, request } = fixture()
    request.mockImplementation(async (route) =>
      route === "GET /bots/:id/files/content"
        ? ({ name: "notes.md", mime: "text/markdown", base64: btoa("# Saved notes") } as never)
        : blob,
    )
    render(<MarkdownContent evidence={context} content="[Notas](/output/notes.md) · [Baixar PNG](/output/post.png)" />)
    expect(await screen.findByRole("img", { name: "Baixar PNG" })).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Notas" }))
    expect(await screen.findByRole("heading", { name: "Saved notes" })).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Fechar arquivo" }))
    fireEvent.click(screen.getByRole("button", { name: "Baixar PNG" }))
    await waitFor(() =>
      expect(saveInvoke).toHaveBeenCalledWith("save_file", expect.objectContaining({ name: "post.png" })),
    )
    expect(request).toHaveBeenCalledWith("GET /bots/:id/images", { path: "/output/post.png" }, { id: context.bot.id })
    const reads = request.mock.calls.filter(([route]) => route === "GET /bots/:id/files/content")
    expect(reads).toEqual([["GET /bots/:id/files/content", { path: "/output/notes.md" }, { id: context.bot.id }]])
    expect(document.querySelector('a[href^="/output/"]')).toBeNull()
  })
  it("detects syntax, links, bare and inline-code paths, deduplicates and leaves fenced code/remote/HTML alone", async () => {
    const { context, request } = fixture()
    const view = render(
      <MarkdownContent
        evidence={context}
        content={
          '![Tela inicial](/workspace/shots/a.png)\n\n[captura](/workspace/shots/b.jpg)\n\n/workspace/shots/c.webp e `./shots/d.gif`, local.jpeg\n\n/workspace/shots/a.png\n\n```sh\n/workspace/ignore.png\n```\n\n![remote](https://example.test/remote.png)\n\n<img src="/workspace/html.png" onerror="alert(1)">'
        }
      />,
    )
    const gallery = await screen.findByRole("region", { name: "Imagens de evidência" }, { timeout: 5000 })
    expect(gallery.querySelectorAll("figure")).toHaveLength(5)
    expect(gallery).toHaveTextContent("Tela inicial")
    await waitFor(() => expect(request).toHaveBeenCalledTimes(5))
    expect(request.mock.calls.map((call) => (call as unknown as [string, { path: string }])[1].path)).toEqual(
      expect.arrayContaining([
        "/workspace/shots/a.png",
        "/workspace/shots/b.jpg",
        "/workspace/shots/c.webp",
        "./shots/d.gif",
        "local.jpeg",
      ]),
    )
    expect(view.container.querySelector("script, img[onerror], img[src^='https:']")).toBeNull()
    expect(view.container.querySelector("pre")).toHaveTextContent("/workspace/ignore.png")
  })
  it("rejects traversal, encoded remote URLs, and dangerous schemes", async () => {
    for (const path of [
      "../a.png",
      "/workspace/../a.png",
      "https://x/a.png",
      "//x/a.png",
      "javascript:a.png",
      "file:///workspace/a.png",
      "x\\a.png",
    ])
      expect(evidencePath(path)).toBe(false)
    const { context, request } = fixture()
    render(
      <MarkdownContent evidence={context} content={"![escape](%2e%2e/a.png)\n\n![remote](https%3A%2F%2Fx%2Fa.png)"} />,
    )
    await screen.findByText("escape")
    expect(screen.queryByRole("region", { name: "Imagens de evidência" })).toBeNull()
    expect(request).not.toHaveBeenCalled()
  })
  it("uses report-directory relative paths from the Library", async () => {
    const { context, request } = fixture()
    const api = createMockApi()
    const baseRequest = api.request
    api.request = async (route, input, params) => {
      if (route === "GET /bots/:id/images") return request(route, input, params) as never
      if (route === "GET /bots/:id/files/content")
        return {
          name: "report.md",
          mime: "text/markdown",
          base64: btoa("# Report\n\n![Checkout](shots/checkout.png)"),
        } as never
      if (route === "GET /bots/:id/files")
        return {
          files: [
            { name: "reports", path: "reports", directory: true, bytes: 0 },
            { name: "report.md", path: "reports/report.md", directory: false, bytes: 60 },
          ],
        } as never
      return baseRequest(route, input, params)
    }
    render(<BotLibrary api={api} bot={context.bot} />)
    fireEvent.click(await screen.findByRole("button", { name: /reports.*Pasta/ }))
    fireEvent.click(await screen.findByRole("button", { name: /report.md.*KB/ }))
    expect(await screen.findByRole("region", { name: "Imagens de evidência" })).toBeVisible()
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "GET /bots/:id/images",
        { path: "shots/checkout.png", base: "reports" },
        { id: context.bot.id },
      ),
    )
  })
})
it("opens the same lightbox for tool screenshots with zoom, navigation, saving, keyboard and focus restoration", async () => {
  const view = render(
    <ToolOutput
      callId="shot"
      raw={JSON.stringify({
        content: [1, 2].map(() => ({ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" })),
      })}
    />,
  )
  const trigger = screen.getByRole("button", { name: "Abrir captura 1 em tamanho original" })
  trigger.focus()
  fireEvent.click(trigger)
  const dialog = await screen.findByRole("dialog")
  await waitFor(() => expect(dialog.querySelector("img")).not.toBeNull())
  expect(dialog.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\//)
  fireEvent.click(screen.getByRole("button", { name: "Aumentar zoom" }))
  expect(dialog.querySelector("img")).toHaveStyle({ transform: "translate(-50%, -50%) translate(0px, 0px) scale(1.5)" })
  const stage = dialog.querySelector(".evidence-stage")
  if (!stage) throw new Error("Missing image stage")
  fireEvent.pointerDown(stage, { clientX: 10, clientY: 10 })
  fireEvent.pointerMove(stage, { clientX: 60, clientY: 30 })
  expect(dialog.querySelector("img")).toHaveStyle({
    transform: "translate(-50%, -50%) translate(50px, 20px) scale(1.5)",
  })
  fireEvent.pointerUp(stage)
  fireEvent.click(screen.getByRole("button", { name: "Próxima" }))
  expect(dialog).toHaveTextContent("2/2")
  fireEvent.keyDown(document, { key: "ArrowLeft" })
  expect(dialog).toHaveTextContent("1/2")
  fireEvent.click(await screen.findByRole("button", { name: "Salvar" }))
  await waitFor(() =>
    expect(saveInvoke).toHaveBeenCalledWith("save_file", expect.objectContaining({ name: "shot-1.png" })),
  )
  expect(await screen.findByText("Salvo em /tmp/shot-1.png")).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Fechar imagem" }))
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(trigger).toHaveFocus()
  view.unmount()
  expect(bitmapClose).toHaveBeenCalled()
  expect(createUrl).not.toHaveBeenCalled()
})
it("keeps tool image labels and download actions with their matching cards", async () => {
  render(
    <ToolOutput
      callId="screens"
      raw={JSON.stringify({
        content: [
          { type: "text", text: "mobile" },
          { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
          { type: "text", text: "Baixar imagem" },
          { type: "text", text: "desktop" },
          { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
          { type: "text", text: "Baixar imagem" },
        ],
      })}
    />,
  )

  const gallery = await screen.findByRole("region", { name: "Imagens de evidência" })
  const cards = Array.from(gallery.querySelectorAll("figure"))

  expect(cards).toHaveLength(2)
  expect(cards[0]).toHaveTextContent("mobile")
  expect(cards[1]).toHaveTextContent("desktop")
  expect(screen.getAllByRole("button", { name: "Baixar imagem" })).toHaveLength(2)
  expect(screen.queryByText("desktop", { selector: "code" })).toBeNull()
})
it("redacts tool image captions before displaying labels and alternative text", async () => {
  const secret = ["sk", "syntheticcaption123456"].join("-")
  render(
    <ToolOutput
      callId="redacted-caption"
      raw={JSON.stringify({
        content: [
          { type: "text", text: secret },
          { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
          { type: "text", text: "Baixar imagem" },
        ],
      })}
    />,
  )

  const gallery = await screen.findByRole("region", { name: "Imagens de evidência" })

  expect(gallery).not.toHaveTextContent(secret)
  expect(gallery.querySelector("figcaption")).toHaveTextContent("[REDACTED]")
  expect(await screen.findByRole("img", { name: "[REDACTED]" })).toBeVisible()
})
it("opens workspace evidence in the Library from the lightbox", async () => {
  const { context } = fixture()
  render(
    <EvidenceContext.Provider value={context}>
      <EvidenceGallery images={[{ path: "/workspace/a.png", filename: "a.png", caption: "Tela" }]} />
    </EvidenceContext.Provider>,
  )
  fireEvent.click(screen.getByRole("button", { name: /Abrir captura/ }))
  fireEvent.click(await screen.findByRole("button", { name: "Abrir na Biblioteca" }))
  expect(context.onLibrary).toHaveBeenCalledWith("/workspace/a.png")
  expect(screen.queryByRole("dialog")).toBeNull()
})
it.each([
  [1080, 1080, 0.6],
  [2160, 1080, 1200 / 2160],
  [1080, 2160, 0.3],
])("fits a %d×%d image and lets zoom-out and fit change its scale", async (width, height, fit) => {
  const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 1200,
    height: 648,
  } as DOMRect)
  try {
    render(
      <EvidenceGallery
        images={[
          {
            path: "square.png",
            src: "data:image/png;base64,iVBORw0KGgo=",
            filename: "square.png",
            caption: "Quadrado",
          },
        ]}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /Abrir captura/ }))
    const dialog = await screen.findByRole("dialog")
    await waitFor(() => expect(dialog.querySelector("img")).not.toBeNull())
    const image = dialog.querySelector("img")
    if (!image) throw new Error("Missing full image")
    Object.defineProperties(image, {
      naturalWidth: { value: width },
      naturalHeight: { value: height },
    })
    fireEvent.load(image)
    expect(image.style.transform).toContain(`scale(${fit})`)
    fireEvent.click(screen.getByRole("button", { name: "Diminuir zoom" }))
    expect(image.style.transform).toContain(`scale(${fit * 0.5})`)
    fireEvent.click(screen.getByRole("button", { name: "Aumentar zoom" }))
    expect(image.style.transform).toContain(`scale(${fit})`)
    fireEvent.click(screen.getByRole("button", { name: "Aumentar zoom" }))
    fireEvent.click(screen.getByRole("button", { name: "Ajustar imagem" }))
    expect(image.style.transform).toContain(`scale(${fit})`)
    const stage = dialog.querySelector(".evidence-stage")
    if (!stage) throw new Error("Missing image stage")
    fireEvent.wheel(stage, { deltaY: 1 })
    expect(image.style.transform).toContain(`scale(${fit * 0.75})`)
  } finally {
    bounds.mockRestore()
  }
})
it("refits the image when its available area changes", async () => {
  let resize: (() => void) | undefined
  const disconnect = vi.fn()
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback
      }
      observe() {}
      disconnect = disconnect
    },
  )
  const bounds = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue({ width: 1200, height: 648 } as DOMRect)
  try {
    const view = render(
      <EvidenceGallery
        images={[
          {
            path: "square.png",
            src: "data:image/png;base64,iVBORw0KGgo=",
            filename: "square.png",
            caption: "Quadrado",
          },
        ]}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /Abrir captura/ }))
    const dialog = await screen.findByRole("dialog")
    await waitFor(() => expect(dialog.querySelector("img")).not.toBeNull())
    const image = dialog.querySelector("img")
    if (!image) throw new Error("Missing full image")
    Object.defineProperties(image, { naturalWidth: { value: 1080 }, naturalHeight: { value: 1080 } })
    fireEvent.load(image)
    expect(image.style.transform).toContain("scale(0.6)")
    bounds.mockReturnValue({ width: 324, height: 648 } as DOMRect)
    act(() => resize?.())
    expect(image.style.transform).toContain("scale(0.3)")
    view.unmount()
    expect(disconnect).toHaveBeenCalledOnce()
  } finally {
    bounds.mockRestore()
  }
})
it("shows stopped VM availability and Computer action without starting a machine", async () => {
  const { context, request } = fixture()
  request.mockRejectedValue(new ApiError(409, "Stopped", "IMAGE_MACHINE_STOPPED"))
  render(<MarkdownContent evidence={context} content="![Tela](/workspace/a.png)" />)
  expect(await screen.findByText("Imagem disponível quando a máquina estiver ligada")).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Abrir Computador" }))
  expect(context.onComputer).toHaveBeenCalled()
  expect(request.mock.calls.every((call) => (call as unknown as [string])[0] === "GET /bots/:id/images")).toBe(true)
})
it("keeps image sources stable across streamed text updates, uses data URLs only and stops reads on unmount", async () => {
  const { context, request } = fixture()
  const view = render(<MarkdownContent evidence={context} content="![Tela](/workspace/a.png)" />)
  const image = await screen.findByRole("img", { name: "Tela" })
  const source = image.getAttribute("src") ?? ""
  expect(source).toMatch(/^data:image\//)
  expect(request).toHaveBeenCalledTimes(1)
  view.rerender(<MarkdownContent evidence={context} content={"![Tela](/workspace/a.png)\n\nMais texto"} />)
  await screen.findByText("Mais texto")
  expect(request).toHaveBeenCalledTimes(1)
  expect(screen.getByRole("img", { name: "Tela" })).toHaveAttribute("src", source)
  const errors = vi.spyOn(console, "error").mockImplementation(() => {})
  view.unmount()
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  expect(errors).not.toHaveBeenCalled()
  expect(createUrl).not.toHaveBeenCalled()
  expect(revokeUrl).not.toHaveBeenCalled()
})

it("never uses object URLs for image sources in ui/src", () => {
  const root = join(import.meta.dirname, "../src")
  const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f))
  const offenders = files.filter(
    (f) => f !== "browserSave.ts" && readFileSync(join(root, f), "utf8").includes("createObjectURL"),
  )
  expect(offenders).toEqual([])
})
it("limits concurrent loads to three", async () => {
  let active = 0
  let maximum = 0
  const release: Array<() => void> = []
  const work = Array.from({ length: 7 }, () =>
    loadImage(async () => {
      active++
      maximum = Math.max(active, maximum)
      await new Promise<void>((resolve) => release.push(resolve))
      active--
    }),
  )
  await act(async () => {
    await Promise.resolve()
  })
  expect(active).toBe(3)
  while (release.length) {
    release.shift()?.()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }
  await Promise.all(work)
  expect(maximum).toBe(3)
})

it("downscales large portrait images without stretching or retaining the original bitmap", async () => {
  const bytes = new Uint8Array(24)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, 1200)
  view.setUint32(20, 2400)
  expect(imageDimensions(bytes)).toEqual({ width: 1200, height: 2400 })
  await thumbnailBlob(new Blob([bytes]))
  expect(createImageBitmap).toHaveBeenCalledWith(expect.any(Blob), {
    resizeWidth: 160,
    resizeHeight: 320,
    resizeQuality: "high",
  })
  expect(bitmapClose).toHaveBeenCalledOnce()
})

it.each([
  [{ width: 1170, height: 2532 }, 1, { width: 148, height: 320 }],
  [{ width: 1170, height: 2532 }, 2, { width: 296, height: 640 }],
  [{ width: 2880, height: 1800 }, 2, { width: 960, height: 600 }],
])("sizes %j previews for device pixel ratio %d", (dimensions, pixelRatio, expected) => {
  expect(getThumbnailSize(dimensions, pixelRatio)).toEqual(expected)
})

it("renders explicit images without extensions and resolves attachment route references", async () => {
  const { context, request } = fixture()
  const id = "a".repeat(64)
  render(
    <MarkdownContent
      evidence={context}
      content={`![Sem extensão](/workspace/shot)\n\n![Anexo](/api/v1/attachments/${id})`}
    />,
  )
  await screen.findByRole("region", { name: "Imagens de evidência" })
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("GET /bots/:id/images", { attachmentId: id }, { id: context.bot.id }),
  )
  expect(request).toHaveBeenCalledWith("GET /bots/:id/images", { path: "/workspace/shot" }, { id: context.bot.id })
})

it("defers image reads until a thumbnail enters the viewport", async () => {
  const { context, request } = fixture()
  let visible: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined
  const disconnect = vi.fn()
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: typeof visible) {
        visible = callback
      }
      observe() {}
      disconnect = disconnect
    },
  )
  render(<MarkdownContent evidence={context} content="![Tela](/workspace/a.png)" />)
  await screen.findByRole("region", { name: "Imagens de evidência" })
  expect(request).not.toHaveBeenCalled()
  act(() => visible?.([{ isIntersecting: true }]))
  const image = await screen.findByRole("img", { name: "Tela" })
  expect(image).toHaveAttribute("loading", "lazy")
  expect(image.getAttribute("src")).toMatch(/^data:image\//)
  expect(createUrl).not.toHaveBeenCalled()
  expect(request).toHaveBeenCalledOnce()
  expect(disconnect).toHaveBeenCalled()
})
