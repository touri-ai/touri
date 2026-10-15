import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { Id, Message, PreviewTarget, Project, Run } from "@touri/contracts"
import * as axe from "axe-core"
import { afterEach, describe, expect, it, vi } from "vitest"
import App, { canUseMockAdapter } from "../src/App"
import type { TauriInvoke } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { PreviewPane } from "../src/components/PreviewPane"
import { SecretsPanel } from "../src/components/RightPanels"

const project: Project = {
  id: "project-test",
  name: "Test project",
  path: "/tmp/test-project",
  gitRemote: null,
  defaultBranch: "main",
  dataDir: "/tmp/touri-project",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  archivedAt: null,
}

const makeMessage = (id: Id, text: string, parentId: Id | null = null): Message => ({
  id,
  threadId: "thread-test",
  parentId,
  role: "assistant",
  kind: "text",
  status: "complete",
  runId: null,
  text,
  parts: [{ type: "text", text }],
  sender: null,
  source: "local",
  createdAt: Date.now(),
  updatedAt: Date.now(),
})

const makeRun = (status: Run["status"], errorClass: Run["errorClass"]): Run => ({
  id: "run-failed",
  threadId: "thread-mark",
  botId: "bot-mark",
  provider: "codex",
  trigger: "user",
  requestMessageId: "m1",
  replyMessageId: "m2",
  externalTurnId: null,
  status,
  errorClass,
  errorMessage: "crashed",
  usage: null,
  routineRunId: null,
  queuedAt: Date.now(),
  startedAt: Date.now(),
  finishedAt: Date.now(),
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("WP9 frontend acceptance", () => {
  it("only permits the mock adapter behind an explicit Vite dev flag", () => {
    expect(canUseMockAdapter({ dev: false, flag: "true" })).toBe(false)
    expect(canUseMockAdapter({ dev: true, flag: undefined })).toBe(false)
    expect(canUseMockAdapter({ dev: true, flag: "true" })).toBe(true)
  })

  it("switches between the approved touri and Bots navigation", async () => {
    const api = createMockApi()
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    expect(screen.getByRole("button", { name: /^Bots/ })).toHaveAttribute("aria-current", "page")
    fireEvent.click(screen.getByRole("button", { name: "touri" }))
    expect(screen.getByRole("button", { name: /Cron/ })).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: /^Bots/ }))
    expect(document.querySelectorAll(".bot-entry")).toHaveLength(api.getState().bots.length)
    fireEvent.click(screen.getByRole("button", { name: "touri" }))
    fireEvent.click(screen.getByRole("button", { name: /MCP/ }))
    expect(await screen.findByRole("heading", { name: "MCP" })).toBeVisible()
  })

  it("opens the create-cron dialog after navigation is recreated", async () => {
    const api = createMockApi()
    const first = render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    fireEvent.click(screen.getByRole("button", { name: "touri" }))
    fireEvent.click(screen.getByRole("button", { name: /Integrações/ }))
    expect(screen.getByRole("heading", { name: "Integrações" })).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: /^Bots/ }))
    fireEvent.click(screen.getByRole("button", { name: "touri" }))
    expect(screen.getByRole("heading", { name: "Cron" })).toBeVisible()
    first.unmount()

    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("heading", { name: "Cron" })
    fireEvent.click(screen.getByRole("button", { name: /Cron/ }))
    fireEvent.click(screen.getByRole("button", { name: /Criar cron/ }))
    expect(await screen.findByRole("heading", { name: "Criar cron" })).toBeVisible()
    expect(screen.queryByRole("heading", { name: "Integrações" })).not.toBeInTheDocument()
  })

  it("connects a project, assigns bots, and defines a supervised process from the modal", async () => {
    const api = createMockApi()
    const request = api.request
    api.request = (async (route, ...args) =>
      route === "GET /projects/:id/git"
        ? {
            branch: "main",
            dirty: false,
            ahead: 0,
            behind: 0,
            commit: "a".repeat(40),
            remote: "https://example.test/project.git",
          }
        : request(route, ...args)) as typeof api.request
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    fireEvent.click(screen.getByRole("button", { name: "Preview do projeto" }))
    fireEvent.click(screen.getByRole("button", { name: "Menu do projeto" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Conectar projeto" }))
    expect(await screen.findByRole("dialog", { name: "Conectar projeto" })).toBeVisible()
    fireEvent.change(screen.getByLabelText("Pasta do projeto"), { target: { value: "/tmp/new-project" } })
    fireEvent.change(screen.getByLabelText("Nome do projeto"), { target: { value: "New project" } })
    fireEvent.click(screen.getByRole("button", { name: "Conectar projeto" }))
    await screen.findByText("Processos")
    expect(await screen.findByText(`Commit: ${"a".repeat(40)}`)).toBeVisible()
    expect(screen.getByText("Origem: https://example.test/project.git")).toBeVisible()
    fireEvent.change(screen.getByLabelText("Nome do processo", { selector: "input", exact: true }), {
      target: { value: "web" },
    })
    fireEvent.change(screen.getByLabelText("Comando", { selector: "input", exact: true }), {
      target: { value: "bun dev" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Adicionar processo" }))
    await waitFor(() => {
      expect(api.calls.some((call) => call.route === "POST /projects")).toBe(true)
      expect(api.calls.some((call) => call.route === "PUT /projects/:id/processes/:name")).toBe(true)
      expect(api.calls.some((call) => call.route === "PATCH /bots/:id")).toBe(true)
    })
    expect(screen.getAllByText("web").length).toBeGreaterThan(0)
  })

  it.each(["create", "assign"])(
    "keeps %s errors visible inside the project dialog and permits retry",
    async (stage) => {
      const api = createMockApi()
      const request = api.request
      let fail = true
      api.request = (async (route, ...args) => {
        if (
          fail &&
          ((stage === "create" && route === "POST /projects") || (stage === "assign" && route === "PATCH /bots/:id"))
        )
          throw new Error("Escolha uma pasta existente e acessível.")
        return request(route, ...args)
      }) as typeof api.request
      render(<App kernel={{ services: { api } }} />)
      await screen.findByRole("textbox", { name: "Mensagem para mark" })
      fireEvent.click(screen.getByRole("button", { name: "Preview do projeto" }))
      fireEvent.click(screen.getByRole("button", { name: "Menu do projeto" }))
      fireEvent.click(screen.getByRole("menuitem", { name: "Conectar projeto" }))
      fireEvent.change(screen.getByLabelText("Pasta do projeto"), { target: { value: "/tmp/missing" } })
      fireEvent.click(screen.getByRole("button", { name: "Conectar projeto" }))
      const alert = await screen.findByRole("alert")
      expect(alert.closest('[role="dialog"]')).not.toBeNull()
      expect(alert).toHaveTextContent("Escolha uma pasta existente e acessível.")
      fail = false
      fireEvent.click(screen.getByRole("button", { name: "Conectar projeto" }))
      await screen.findByText("Processos")
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
      expect(api.calls.filter((call) => call.route === "POST /projects")).toHaveLength(1)
    },
  )

  it("asks before using an already connected folder and preserves the requested name", async () => {
    const api = createMockApi()
    const existing = (await api.request("GET /projects", {})).projects[0] as Project
    existing.name = "r3-MyApp"
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    fireEvent.click(screen.getByRole("button", { name: "Preview do projeto" }))
    fireEvent.click(screen.getByRole("button", { name: "Menu do projeto" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Conectar projeto" }))
    fireEvent.change(screen.getByLabelText("Pasta do projeto"), { target: { value: `${existing.path}/` } })
    fireEvent.change(screen.getByLabelText("Nome do projeto"), { target: { value: "r10-myapp-readonly" } })
    expect(await screen.findByText("Esta pasta já está conectada como r3-MyApp")).toBeVisible()
    expect(screen.getByLabelText("Nome do projeto")).toHaveValue("r10-myapp-readonly")
    expect(screen.queryByRole("button", { name: "Conectar com outro nome" })).toBeNull()
    expect(api.calls.filter((call) => call.route === "POST /projects")).toHaveLength(0)
    expect(api.calls.filter((call) => call.route === "PATCH /bots/:id")).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: "Usar r3-MyApp" }))
    await screen.findByText("Processos")
    expect(api.calls.filter((call) => call.route === "POST /projects")).toHaveLength(0)
    expect(api.calls.find((call) => call.route === "PATCH /bots/:id")?.input).toEqual({ projectId: existing.id })
  })

  it("clears the duplicate notice when choosing a different folder without losing the name", async () => {
    const api = createMockApi()
    const existing = (await api.request("GET /projects", {})).projects[0] as Project
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    fireEvent.click(screen.getByRole("button", { name: "Preview do projeto" }))
    fireEvent.click(screen.getByRole("button", { name: "Menu do projeto" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Conectar projeto" }))
    fireEvent.change(screen.getByLabelText("Pasta do projeto"), { target: { value: existing.path } })
    fireEvent.change(screen.getByLabelText("Nome do projeto"), { target: { value: "r10-myapp-readonly" } })
    await screen.findByText(`Esta pasta já está conectada como ${existing.name}`)
    fireEvent.change(screen.getByLabelText("Pasta do projeto"), { target: { value: "/tmp/new-folder" } })
    expect(screen.queryByText(/Esta pasta já está conectada/)).toBeNull()
    expect(screen.getByLabelText("Nome do projeto")).toHaveValue("r10-myapp-readonly")
    fireEvent.click(screen.getByRole("button", { name: "Conectar projeto" }))
    await screen.findByText("Processos")
    expect(api.calls.find((call) => call.route === "POST /projects")?.input).toEqual({
      path: "/tmp/new-folder",
      name: "r10-myapp-readonly",
    })
  })

  it.each(["refresh", "canonical path"])(
    "requires explicit reuse when a duplicate is discovered via %s",
    async (stage) => {
      const api = createMockApi()
      const existing = (await api.request("GET /projects", {})).projects[0] as Project
      existing.name = "r3-MyApp"
      const request = api.request
      let showExisting = false
      const create = vi.fn()
      api.request = (async (route, input, path) => {
        if (route === "GET /projects" && !showExisting) return { projects: [] }
        if (route === "POST /projects") {
          create(input)
          return { project: existing }
        }
        return request(route, input, path)
      }) as typeof api.request
      render(<App kernel={{ services: { api } }} />)
      await screen.findByRole("textbox", { name: "Mensagem para mark" })
      fireEvent.click(screen.getByRole("button", { name: "Preview do projeto" }))
      fireEvent.click(screen.getByRole("button", { name: "Menu do projeto" }))
      fireEvent.click(screen.getByRole("menuitem", { name: "Conectar projeto" }))
      fireEvent.change(screen.getByLabelText("Pasta do projeto"), {
        target: { value: stage === "refresh" ? existing.path : "/tmp/alias-to-myapp" },
      })
      fireEvent.change(screen.getByLabelText("Nome do projeto"), { target: { value: "r10-myapp-readonly" } })
      showExisting = true
      fireEvent.click(
        within(screen.getByRole("dialog", { name: "Conectar projeto" })).getByRole("button", {
          name: "Conectar projeto",
        }),
      )
      expect(await screen.findByText("Esta pasta já está conectada como r3-MyApp")).toBeVisible()
      expect(screen.getByLabelText("Nome do projeto")).toHaveValue("r10-myapp-readonly")
      expect(api.calls.filter((call) => call.route === "PATCH /bots/:id")).toHaveLength(0)
      expect(create).toHaveBeenCalledTimes(stage === "refresh" ? 0 : 1)
      fireEvent.click(screen.getByRole("button", { name: "Usar r3-MyApp" }))
      await screen.findByText("Processos")
      expect(create).toHaveBeenCalledTimes(stage === "refresh" ? 0 : 1)
      expect(api.calls.find((call) => call.route === "PATCH /bots/:id")?.input).toEqual({ projectId: existing.id })
    },
  )

  it("renders all 500 streaming deltas without dropping text", async () => {
    const api = createMockApi()
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    act(() =>
      api.emit({
        type: "message.updated",
        message: {
          ...(api.getState().messages.find((message) => message.id === "m2") as Message),
          status: "streaming",
        },
      }),
    )
    await act(async () => {
      for (let index = 0; index < 500; index += 1)
        api.emit({ type: "message.delta", threadId: "thread-mark", messageId: "m2", partIndex: 0, delta: `d${index}|` })
    })
    await waitFor(() => {
      const content = document.querySelector('[data-message-id="m2"]')?.textContent ?? ""
      expect(content).toContain("d0|")
      expect(content).toContain("d499|")
    })
  })

  it("keeps a 1,200-message transcript virtualized", () => {
    const messages = Array.from({ length: 1200 }, (_, index) => makeMessage(`m-${index}`, `Message ${index}`))
    render(<VirtualMessageList messages={messages} onSwitchBranch={() => undefined} onRetry={async () => undefined} />)
    expect(screen.getByTestId("virtual-message-list").querySelectorAll("article").length).toBeLessThan(60)
  })

  it("switches a branch through PATCH /threads/:id with activeLeafId", async () => {
    const api = createMockApi()
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    const branch = { ...makeMessage("branch-2", "A sibling answer"), threadId: "thread-mark" }
    act(() => api.emit({ type: "message.created", message: branch }))
    const next = (await screen.findAllByRole("button", { name: "Próxima ramificação" }))[0]
    if (!next) throw new Error("branch switcher did not render")
    fireEvent.click(next)
    await waitFor(() =>
      expect(
        api.calls.some(
          (call) => call.route === "PATCH /threads/:id" && JSON.stringify(call.input).includes("activeLeafId"),
        ),
      ).toBe(true),
    )
  })

  it("shows a failed assistant reply and retries through /runs/:id/retry", async () => {
    const api = createMockApi()
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    act(() => {
      api.emit({ type: "run.updated", run: makeRun("failed", "cli_crash") })
      api.emit({
        type: "message.updated",
        message: {
          ...makeMessage("m2", "Partial answer"),
          threadId: "thread-mark",
          status: "failed",
          runId: "run-failed",
        },
      })
    })
    const retry = await screen.findByRole("button", { name: "Tentar novamente" })
    fireEvent.click(retry)
    await waitFor(() => expect(api.calls.some((call) => call.route === "POST /runs/:id/retry")).toBe(true))
  })

  it("keeps secret values out of fetch/API requests", async () => {
    const api = createMockApi()
    const invokeSecret = vi.fn(async () => true)
    render(<SecretsPanel project={project} api={api} invokeSecret={invokeSecret} onNotice={() => undefined} />)
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "API_TOKEN" } })
    fireEvent.change(screen.getByLabelText("Valor"), { target: { value: "super-secret-value" } })
    fireEvent.click(screen.getByRole("button", { name: "Salvar no Keychain" }))
    await waitFor(() => expect(invokeSecret).toHaveBeenCalledWith("project-test/API_TOKEN", "super-secret-value"))
    expect(JSON.stringify(api.calls)).not.toContain("super-secret-value")
    expect(api.calls.some((call) => call.route === "PUT /projects/:id/secrets/:name")).toBe(true)
  })

  it("syncs the preview slot bounds and hides the native preview behind a modal", async () => {
    let left = 20
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      left,
      top: 50,
      x: left,
      y: 50,
      width: 500,
      height: 300,
      right: left + 500,
      bottom: 350,
      toJSON: () => ({}),
    }))
    const preview: PreviewTarget = {
      projectId: project.id,
      processId: "process-web",
      url: "http://localhost:4310",
      port: 4310,
      label: "web",
    }
    const invokeCommand = vi.fn(async (command: Parameters<TauriInvoke>[0]) =>
      command === "preview_show" ? { label: "preview-label" } : {},
    ) as unknown as TauriInvoke
    class FakeResizeObserver {
      private readonly callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
      }
      observe(element: Element): void {
        this.callback([{ target: element } as ResizeObserverEntry], this)
      }
      disconnect(): void {}
      unobserve(): void {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver)
    const { rerender } = render(
      <PreviewPane
        preview={preview}
        modalOpen={false}
        invokeCommand={invokeCommand}
        onOpenAgentBrowser={() => undefined}
      />,
    )
    await waitFor(() => expect(invokeCommand).toHaveBeenCalledWith("preview_show", expect.anything()))
    left = 30
    await waitFor(() =>
      expect(invokeCommand).toHaveBeenCalledWith(
        "preview_set_bounds",
        expect.objectContaining({ label: "preview-label" }),
      ),
    )
    rerender(
      <PreviewPane
        preview={preview}
        modalOpen={true}
        invokeCommand={invokeCommand}
        onOpenAgentBrowser={() => undefined}
      />,
    )
    await waitFor(() => expect(invokeCommand).toHaveBeenCalledWith("preview_hide", { label: "preview-label" }))
  })

  it("opens the doctor and import dialogs from onboarding before any bot exists", async () => {
    const mock = createMockApi()
    const api = {
      ...mock,
      request: (async (route, input, pathValues) =>
        route === "GET /bots" ? { bots: [] } : mock.request(route, input, pathValues)) as typeof mock.request,
    }
    render(<App kernel={{ services: { api } }} />)
    fireEvent.click(await screen.findByRole("button", { name: /Verificar este Mac/ }))
    expect(await screen.findByRole("dialog", { name: "Diagnóstico" })).toBeVisible()
    fireEvent.keyDown(document, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Diagnóstico" })).toBeNull())
    fireEvent.click(screen.getByRole("button", { name: "Importar do app anterior" }))
    expect(await screen.findByRole("dialog")).toBeVisible()
  })

  it("has no serious or critical axe violations on the main screen", async () => {
    const api = createMockApi()
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    const result = await axe.run(document.body)
    expect(result.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual(
      [],
    )
  })
})

it("r2: switches native preview URL and hides the previous bot preview, including delayed native creation", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 20,
    top: 50,
    x: 20,
    y: 50,
    width: 500,
    height: 300,
    right: 520,
    bottom: 350,
    toJSON: () => ({}),
  })
  const a: PreviewTarget = { projectId: "a", processId: "pa", url: "http://localhost:4101", port: 4101, label: "A" }
  const b: PreviewTarget = { projectId: "b", processId: "pb", url: "http://localhost:4102", port: 4102, label: "B" }
  let finishA: ((result: { label: string }) => void) | undefined
  const invoke = vi.fn(async (command: string, args: { url?: string; label?: string }) => {
    if (command === "preview_show" && args.url === a.url)
      return new Promise<{ label: string }>((resolve) => {
        finishA = resolve
      })
    if (command === "preview_show") return { label: "native-b" }
    return {}
  }) as unknown as TauriInvoke
  const view = render(
    <PreviewPane preview={a} modalOpen={false} invokeCommand={invoke} onOpenAgentBrowser={() => undefined} />,
  )
  await waitFor(() => expect(finishA).toBeDefined())
  view.rerender(
    <PreviewPane preview={b} modalOpen={false} invokeCommand={invoke} onOpenAgentBrowser={() => undefined} />,
  )
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("preview_show", expect.objectContaining({ url: b.url })))
  await act(async () => finishA?.({ label: "native-a" }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("preview_hide", { label: "native-a" }))
  view.unmount()
  expect(invoke).toHaveBeenCalledWith("preview_hide", { label: "native-b" })
})

it("opens the new bot conversation after completing creation from a global screen", async () => {
  const api = createMockApi()
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  fireEvent.click(screen.getByRole("button", { name: "touri" }))
  fireEvent.click(screen.getByRole("button", { name: "Criar bot" }))
  fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Clara" } })
  for (let step = 0; step < 4; step++) fireEvent.click(screen.getByRole("button", { name: "Continuar" }))
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Criar bot" }))
  expect(await screen.findByRole("textbox", { name: "Mensagem para Clara" })).toBeVisible()
  expect(screen.getByRole("button", { name: /^Bots/ })).toHaveAttribute("aria-current", "page")
  expect(api.calls.filter((call) => call.route === "POST /bots")).toHaveLength(1)
})
