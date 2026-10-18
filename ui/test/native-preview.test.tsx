import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { PreviewTarget } from "@touri/contracts"
import { afterEach, describe, expect, it, vi } from "vitest"
import App from "../src/App"
import type { TauriInvoke } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { PreviewPane } from "../src/components/PreviewPane"
import { NativePreview } from "../src/nativePreview"

const bounds = { x: 30, y: 90, width: 500, height: 300 }
const preview: PreviewTarget = {
  projectId: "project-demo",
  processId: "process-web",
  url: "http://localhost:4310/",
  label: "web",
  port: 4310,
}
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const geometry = () =>
  vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue({ ...bounds, left: bounds.x, top: bounds.y, right: 530, bottom: 390, toJSON: () => ({}) })
const nativeInvoke = () =>
  vi.fn(async (command: string) =>
    command === "preview_show" ? { label: `preview-${crypto.randomUUID()}` } : {},
  ) as unknown as TauriInvoke

describe("P1-1 native preview ownership", () => {
  it("shows, repositions, destroys and can reopen with a new handle", async () => {
    const invoke = nativeInvoke()
    const state = new NativePreview(invoke)
    const label = await state.show(preview.url, bounds)
    await state.reposition({ ...bounds, x: 100 })
    expect(invoke).toHaveBeenCalledWith("preview_set_bounds", { label, bounds: { ...bounds, x: 100 } })
    await state.hide()
    await state.hide()
    expect(invoke).toHaveBeenCalledWith("preview_hide", { label })
    const next = await state.show(preview.url, bounds)
    expect(next).not.toBe(label)
    await state.hide()
  })

  it("destroys late create responses without hiding a newer pane", async () => {
    let finish: ((value: { label: string }) => void) | undefined
    const invoke = vi.fn(async (command: string, args: { url?: string }) => {
      if (command === "preview_show" && args.url === "http://localhost:1")
        return new Promise<{ label: string }>((resolve) => {
          finish = resolve
        })
      return command === "preview_show" ? { label: "preview-new" } : {}
    }) as unknown as TauriInvoke
    const state = new NativePreview(invoke)
    const first = state.show("http://localhost:1", bounds)
    await waitFor(() => expect(finish).toBeDefined())
    await state.hide()
    expect(await state.show("http://localhost:2", bounds)).toBe("preview-new")
    finish?.({ label: "preview-old" })
    expect(await first).toBeNull()
    expect(invoke).toHaveBeenCalledWith("preview_hide", { label: "preview-old" })
    expect(invoke).not.toHaveBeenCalledWith("preview_hide", { label: "preview-new" })
    await state.hide()
  })

  it("hides on modal, resize, process stop and unmount; placeholder has no stale iframe", async () => {
    geometry()
    const invoke = nativeInvoke()
    const props = { preview, modalOpen: false, invokeCommand: invoke, onOpenAgentBrowser: vi.fn() }
    const view = render(<PreviewPane {...props} />)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("preview_show", { url: preview.url, bounds }))
    await act(async () => fireEvent(window, new Event("resize")))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("preview_hide", expect.anything()))
    await waitFor(() =>
      expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "preview_show")).toHaveLength(2),
    )
    view.rerender(<PreviewPane {...props} modalOpen />)
    await waitFor(() =>
      expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "preview_hide")).toHaveLength(2),
    )
    view.rerender(<PreviewPane {...props} />)
    await waitFor(() =>
      expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "preview_show")).toHaveLength(3),
    )
    view.rerender(<PreviewPane {...props} preview={null} />)
    await waitFor(() =>
      expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "preview_hide")).toHaveLength(3),
    )
    expect(screen.getByText("Nenhum preview disponível")).toBeVisible()
    expect(document.querySelector("iframe")).toBeNull()
    view.unmount()
  })

  it("routes Logs, Navegador, search, project modal and Cron away from the native view", async () => {
    geometry()
    const api = createMockApi()
    const invoke = nativeInvoke()
    render(<App kernel={{ services: { api, invoke } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    if (!screen.queryByRole("button", { name: "Preview do projeto" }))
      fireEvent.click(screen.getByRole("button", { name: "Painel do bot" }))
    fireEvent.click(screen.getByRole("button", { name: "Preview do projeto" }))
    act(() => api.emit({ type: "preview.available", preview }))
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "preview_show")).toBe(true))
    for (const name of ["Logs", "Navegador"]) {
      await act(async () => fireEvent.click(screen.getByRole("tab", { name })))
      const hidden = vi.mocked(invoke).mock.calls.filter(([command]) => command === "preview_hide").length
      expect(hidden).toBeGreaterThan(0)
      fireEvent.click(screen.getByRole("tab", { name: "Preview" }))
      await waitFor(() =>
        expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "preview_show")).toHaveLength(hidden + 1),
      )
    }
    fireEvent.keyDown(window, { key: "k", metaKey: true })
    await waitFor(() =>
      expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "preview_hide")).toHaveLength(3),
    )
    fireEvent.keyDown(window, { key: "Escape" })
    await waitFor(() =>
      expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "preview_show")).toHaveLength(4),
    )
    fireEvent.click(screen.getByRole("button", { name: "Menu do projeto" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Conectar projeto" }))
    await waitFor(() =>
      expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "preview_hide")).toHaveLength(4),
    )
    fireEvent.click(screen.getByRole("button", { name: "Fechar diálogo" }))
    await waitFor(() =>
      expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "preview_show")).toHaveLength(5),
    )
    fireEvent.click(screen.getByRole("button", { name: "Notificações", exact: true }))
    fireEvent.click(screen.getByRole("button", { name: "Tarefas interrompidas", exact: true }))
    await screen.findByRole("dialog", { name: "Tarefas interrompidas", exact: true })
    await waitFor(() =>
      expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "preview_hide")).toHaveLength(5),
    )
    fireEvent.click(screen.getByRole("button", { name: "Fechar diálogo" }))
    await waitFor(() =>
      expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "preview_show")).toHaveLength(6),
    )

    fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
    fireEvent.click(screen.getByRole("button", { name: "Integrações", exact: true }))
    await waitFor(() =>
      expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "preview_hide")).toHaveLength(6),
    )
  })
})
