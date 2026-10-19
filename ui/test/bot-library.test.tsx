import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { BotLibrary, getFileSize } from "../src/components/BotLibrary"

afterEach(cleanup)
const fixture = () => {
  const api = createMockApi()
  const bot = api.getState().bots.find((entry) => entry.id === "bot-mark")
  if (!bot) throw new Error("Bot da fixture ausente")
  return { api, bot: { ...bot, machine: "local" as const, projectId: null, cwd: null } }
}

test("shows familiar file sizes and limits in the library", async () => {
  const { api, bot } = fixture()
  render(<BotLibrary api={api} bot={bot} />)

  const notes = await screen.findByRole("button", { name: /notas.md.*1 KB/ })
  const limits = await screen.findByText(/512 KB/)

  expect(notes).toHaveTextContent("1 KB")
  expect(limits).toHaveTextContent("512 KB")
  expect(notes).not.toHaveTextContent(/KiB|MiB/)
  expect(limits).not.toHaveTextContent(/KiB|MiB/)
})

test("formats large file sizes with a localized decimal", async () => {
  const { api, bot } = fixture()
  const request = api.request
  api.request = async (route, input, params) => {
    if (route === "GET /bots/:id/files")
      return {
        files: [{ name: "imagem.png", path: "/mock/imagem.png", directory: false, bytes: 1536 * 1024 }],
      } as never
    return request(route, input, params)
  }

  render(<BotLibrary api={api} bot={bot} />)

  expect(await screen.findByRole("button", { name: /imagem.png.*1,5 MB/ })).toHaveTextContent("1,5 MB")
  expect(getFileSize(1536 * 1024, "en")).toBe("1.5 MB")
})

test("folder errors clear the old listing and retry that exact folder", async () => {
  const { api, bot } = fixture()
  const request = api.request
  let failed = true
  api.request = async (route, input, params) => {
    if (route === "GET /bots/:id/files" && (input as { path: string }).path === "documentos") {
      if (failed) throw new Error("Não foi possível ler esta pasta. [TOURI-E1001]")
      return { files: [] } as never
    }
    return request(route, input, params)
  }
  render(<BotLibrary api={api} bot={bot} />)
  fireEvent.click(await screen.findByRole("button", { name: /documentos.*Pasta/ }))
  expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível abrir “documentos”")
  expect(screen.queryByRole("button", { name: /notas.md.*KB/ })).toBeNull()
  expect(screen.queryByText("Nenhum arquivo por aqui")).toBeNull()
  failed = false
  fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }))
  expect(await screen.findByText("Esta pasta está vazia.")).toBeVisible()
  expect(screen.queryByRole("button", { name: /notas.md.*KB/ })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: /Pasta anterior/ }))
  expect(await screen.findByRole("button", { name: /notas.md.*KB/ })).toBeVisible()
})

test("an empty folder replaces the root contents without stale files", async () => {
  const { api, bot } = fixture()
  render(<BotLibrary api={api} bot={bot} />)
  fireEvent.click(await screen.findByRole("button", { name: /documentos.*Pasta/ }))
  expect(await screen.findByText("Nenhum arquivo por aqui")).toBeVisible()
  expect(screen.queryByRole("button", { name: /notas.md.*KB/ })).toBeNull()
})

test("file opening resets the panel scroll and focuses the title; retry reads the file", async () => {
  const { api, bot } = fixture()
  const request = api.request
  let failed = true
  let reads = 0
  api.request = async (route, input, params) => {
    if (route === "GET /bots/:id/files/content") {
      reads += 1
      if (failed) throw new Error("Arquivo temporariamente indisponível")
    }
    return request(route, input, params)
  }
  const view = render(
    <div className="bot-panel-body">
      <BotLibrary api={api} bot={bot} />
    </div>,
  )
  const scroller = view.container.firstElementChild as HTMLElement
  scroller.scrollTop = 500
  fireEvent.click(await screen.findByRole("button", { name: /notas.md.*KB/ }))
  expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível abrir “notas.md”")
  failed = false
  fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }))
  expect(await screen.findByRole("heading", { name: "notas.md" })).toHaveFocus()
  expect(scroller.scrollTop).toBe(0)
  expect(screen.getByRole("button", { name: "Voltar aos arquivos" })).toBeVisible()
  expect(reads).toBe(2)
})

test("origin labels and root paths match bot, project and VM file roots", async () => {
  const { api, bot } = fixture()
  const view = render(<BotLibrary api={api} bot={bot} />)
  expect(screen.getByRole("heading", { name: "Pasta do bot" })).toBeVisible()
  expect(screen.getByText(bot.homeDir)).toBeVisible()
  view.rerender(<BotLibrary api={api} bot={{ ...bot, projectId: "project-demo" }} />)
  expect(await screen.findByText("/Users/demo/javascript/touri-demo")).toBeVisible()
  expect(screen.getByRole("heading", { name: "Workspace do projeto" })).toBeVisible()
  await act(async () => view.rerender(<BotLibrary api={api} bot={{ ...bot, machine: "vm" }} />))
  expect(screen.getByRole("heading", { name: "Workspace da VM" })).toBeVisible()
  expect(screen.getByText("/workspace")).toBeVisible()
})

test("authorized folders can be browsed, previewed and downloaded without duplicating absolute paths", async () => {
  const { api, bot } = fixture()
  const grant = "/output/marketing"
  const request = vi.fn(async (route: string, input: { path?: string }) => {
    if (route === "GET /bots/:id/files")
      return {
        files:
          input.path === grant
            ? [{ name: "post-01.png", path: `${grant}/post-01.png`, directory: false, bytes: 12 }]
            : [],
      }
    if (route === "GET /bots/:id/files/content")
      return { name: "post-01.png", mime: "image/png", base64: btoa("PNG bytes") }
    return new Blob(["PNG bytes"], { type: "image/png" })
  })
  const invoke = vi.fn(async () => ({ path: "/tmp/post-01.png" }))
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke } })
  const view = render(
    <BotLibrary
      api={{ ...api, request: request as never }}
      bot={{ ...bot, folders: [{ path: grant, access: "read-only" }] }}
    />,
  )
  fireEvent.click(screen.getByRole("button", { name: grant }))
  fireEvent.click(await screen.findByRole("button", { name: /post-01.png.*KB/ }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "GET /bots/:id/images",
      { path: `${grant}/post-01.png`, base: grant },
      { id: bot.id },
    ),
  )
  expect(screen.getByText(`${grant}/post-01.png`)).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Baixar arquivo" }))
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("save_file", { name: "post-01.png", dataBase64: btoa("PNG bytes") }, undefined),
  )
  expect(request).toHaveBeenCalledWith("GET /bots/:id/files/content", { path: `${grant}/post-01.png` }, { id: bot.id })
  fireEvent.click(screen.getByRole("button", { name: "Voltar aos arquivos" }))
  fireEvent.click(screen.getByRole("button", { name: "Raiz" }))
  await waitFor(() => expect(request).toHaveBeenLastCalledWith("GET /bots/:id/files", { path: "" }, { id: bot.id }))
  view.rerender(
    <BotLibrary
      api={{ ...api, request: request as never }}
      bot={{ ...bot, folders: [{ path: grant, access: "read-only" }] }}
      request={{ path: `${grant}/post-01.png`, request: 1 }}
    />,
  )
  expect(await screen.findByRole("heading", { name: "post-01.png" })).toBeVisible()
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

test("changing the workspace discards an earlier pending file read", async () => {
  const { api, bot } = fixture()
  const request = api.request
  let finish: ((content: { name: string; mime: string; base64: string }) => void) | undefined
  api.request = async (route, input, params) => {
    if (route === "GET /bots/:id/files/content")
      return (await new Promise<{ name: string; mime: string; base64: string }>((resolve) => {
        finish = resolve
      })) as never
    return request(route, input, params)
  }
  const view = render(<BotLibrary api={api} bot={bot} />)
  fireEvent.click(await screen.findByRole("button", { name: /notas.md.*KB/ }))
  view.rerender(<BotLibrary api={api} bot={{ ...bot, cwd: "/new-workspace" }} />)
  await act(async () => finish?.({ name: "stale.md", mime: "text/markdown", base64: btoa("Conteúdo antigo") }))
  await waitFor(() => expect(screen.queryByRole("article")).toBeNull())
  expect(screen.getByText("/new-workspace")).toBeVisible()
})

test("Baixar on a library file saves through the native save_file command, never a webview download", async () => {
  const invoke = vi.fn(async (_command: string, _args: unknown) => ({ path: "/Users/test/Downloads/notas.md" }))
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke } })
  const clicks = vi.spyOn(HTMLAnchorElement.prototype, "click")
  const { api, bot } = fixture()
  render(<BotLibrary api={api} bot={bot} />)
  fireEvent.click(await screen.findByRole("button", { name: "Baixar notas.md" }))
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Salvo em /Users/test/Downloads/notas.md"))
  expect(invoke).toHaveBeenCalledWith("save_file", expect.objectContaining({ name: "notas.md" }), undefined)
  expect(clicks).not.toHaveBeenCalled()
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

test("Baixar on an image saves the raw file bytes even when the image route refuses the file", async () => {
  const invoke = vi.fn(async (_command: string, _args: unknown) => ({ path: "/Users/test/Downloads/foto.jpg" }))
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: { invoke } })
  const { api, bot } = fixture()
  const jpg = btoa(String.fromCharCode(255, 216, 255, 224, 0, 16))
  const routes: string[] = []
  const request = (async (route: string, input: unknown, pathValues?: Record<string, string>) => {
    routes.push(route)
    if (route === "GET /bots/:id/files")
      return { files: [{ name: "foto.jpg", path: "r13/foto.jpg", directory: false, bytes: 54272 }] }
    if (route === "GET /bots/:id/files/content") return { name: "foto.jpg", mime: "image/jpeg", base64: jpg }
    if (route === "GET /bots/:id/images")
      throw new Error("Confira os dados informados e tente novamente. [TOURI-E1001]")
    return api.request(route as never, input as never, pathValues)
  }) as typeof api.request
  render(<BotLibrary api={{ ...api, request }} bot={bot} />)
  fireEvent.click(await screen.findByRole("button", { name: "Baixar foto.jpg" }))
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Salvo em /Users/test/Downloads/foto.jpg"))
  expect(invoke).toHaveBeenCalledWith("save_file", { name: "foto.jpg", dataBase64: jpg }, undefined)
  expect(routes).not.toContain("GET /bots/:id/images")
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})
