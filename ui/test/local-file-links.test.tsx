import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { MarkdownContent } from "../src/components/MarkdownContent"
import { ApiError } from "../src/errors"
import { localFilePath } from "../src/messageMarkdown"
import { saveFile } from "../src/saveFile"

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }))
vi.mock("../src/saveFile", async (original) => ({
  ...(await original<typeof import("../src/saveFile")>()),
  saveFile: vi.fn(async () => ({ status: "cancelled" })),
}))

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "")
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open")
  }
})

const fixture = (read: () => Promise<unknown>) => {
  const api = createMockApi()
  const bot = api.getState().bots[0]
  if (!bot) throw new Error("Missing bot")
  const request = vi.fn(read)
  return { evidence: { api: { ...api, request: request as never }, bot }, request }
}

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__")
})

describe("local files in chat Markdown", () => {
  it("recognizes local URLs without treating remote URLs or unsafe schemes as files", () => {
    for (const path of ["/workspace/notas.md", "file:///workspace/notas.md", "%2Fworkspace%2Fnotas.md"])
      expect(localFilePath(path)).toBe("/workspace/notas.md")
    for (const path of [
      "https://example.test/notas.md",
      "//example.test/notas.md",
      "javascript:alert(1)",
      "file://example.test/notes.md",
    ])
      expect(localFilePath(path)).toBeNull()
    expect(localFilePath("/workspace/100%.txt")).toBe("/workspace/100%.txt")
  })

  it.each([false, true])("opens absolute links through the bot API (desktop: %s)", async (desktop) => {
    if (desktop) Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} })
    const { evidence, request } = fixture(async () => ({
      name: "notas.md",
      mime: "text/markdown",
      base64: btoa("# Notas salvas"),
    }))
    render(<MarkdownContent content="Salvo em [notas.md](/workspace/notas.md)" evidence={evidence} />)
    const link = await screen.findByRole("button", { name: "notas.md" })
    expect(document.querySelector('a[href="/workspace/notas.md"]')).toBeNull()
    fireEvent.click(link)
    expect(await screen.findByRole("heading", { name: "Notas salvas" })).toBeVisible()
    expect(request).toHaveBeenCalledWith(
      "GET /bots/:id/files/content",
      { path: "/workspace/notas.md" },
      { id: evidence.bot.id },
    )
    expect(screen.getByRole("button", { name: "Baixar arquivo" })).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Baixar arquivo" }))
    expect(saveFile).toHaveBeenCalledWith({ name: "notas.md", mime: "text/markdown", base64: btoa("# Notas salvas") })
    fireEvent.click(screen.getByRole("button", { name: "Fechar arquivo" }))
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("previews raster file bytes without navigating to their local path", async () => {
    const { evidence } = fixture(async () => ({ name: "shot.png", mime: "image/png", base64: "iVBORw0KGgo=" }))
    render(<MarkdownContent evidence={evidence} content="[imagem](/workspace/shot.bin)" />)
    fireEvent.click(await screen.findByRole("button", { name: "imagem", exact: true }))
    const preview = await screen.findByRole("dialog")
    expect(preview.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgo=")
  })

  it("rewrites encoded and file URLs, bare paths and inline code, preserving remote links and fences", async () => {
    const { evidence, request } = fixture(async () => ({
      name: "nota final.txt",
      mime: "text/plain",
      base64: btoa("Pronto"),
    }))
    render(
      <MarkdownContent
        evidence={evidence}
        content={
          "[codificado](/workspace/nota%20final.txt) e [arquivo](file:///workspace/nota%20final.txt)\n\n/workspace/notas.md e `/workspace/nota final.txt`\n\n[site](https://example.test/notas.md)\n\n```text\n/workspace/ignorar.md\n```"
        }
      />,
    )
    for (const name of ["codificado", "arquivo", "/workspace/notas.md", "/workspace/nota final.txt"])
      expect(await screen.findByRole("button", { name })).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "arquivo" }))
    expect(await screen.findByText("Pronto")).toBeVisible()
    expect(request).toHaveBeenCalledWith(
      "GET /bots/:id/files/content",
      { path: "/workspace/nota final.txt" },
      { id: evidence.bot.id },
    )
    expect(screen.getByRole("link", { name: "site" })).toHaveAttribute("href", "https://example.test/notas.md")
    expect(screen.queryByRole("button", { name: "/workspace/ignorar.md" })).toBeNull()
  })

  it.each([403, 404, 422])("shows a friendly inline message for unavailable files (%s)", async (status) => {
    const { evidence } = fixture(async () => {
      throw new ApiError(status, '{"error":"NOT_FOUND"}')
    })
    render(<MarkdownContent evidence={evidence} content="[notas.md](/workspace/notas.md)" />)
    fireEvent.click(await screen.findByRole("button", { name: "notas.md" }))
    const error = await screen.findByRole("alert")
    expect(error).toHaveTextContent(status === 403 ? "pastas permitidas" : "removido")
    expect(error).not.toHaveTextContent("NOT_FOUND")
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("uses a familiar size in the error for files that are too large to preview", async () => {
    const { evidence } = fixture(async () => {
      throw new ApiError(413, '{"error":"ATTACHMENT_TOO_LARGE"}')
    })
    render(<MarkdownContent evidence={evidence} content="[notas.md](/workspace/notas.md)" />)

    fireEvent.click(await screen.findByRole("button", { name: "notas.md" }))

    const error = await screen.findByRole("alert")
    expect(error).toHaveTextContent("512 KB")
    expect(error).not.toHaveTextContent(/KiB|MiB/)
  })

  it("keeps local paths inside touri even without a bot context", async () => {
    render(<MarkdownContent content="[notas.md](/workspace/notas.md)" />)
    fireEvent.click(await screen.findByRole("button", { name: "notas.md" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("conversa do bot")
  })
})
