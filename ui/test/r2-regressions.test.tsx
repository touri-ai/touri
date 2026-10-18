import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react"
import type { ApiRoutes, Bot, Message, Run, Thread, UiEventEnvelope } from "@touri/contracts"
import { describe, expect, it, vi } from "vitest"
import App from "../src/App"
import type { ApiRequest, UiApi } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { ChatPanel, VirtualMessageList } from "../src/components/ChatPanel"
import { BotCreateModal, BotSettingsModal, ProjectModal } from "../src/components/Modals"
import { dictionaries, t } from "../src/i18n"
import { useWorkspace } from "../src/useWorkspace"
import { openRoutines } from "./workspaceNavigation"

// REST serialization matters: callers must not mutate the server's arrays by reference.
const fixtureApi = (deferEvents = false) => {
  const mock = createMockApi()
  const request: ApiRequest = async (route, input, path) => structuredClone(await mock.request(route, input, path))
  const queued: Array<() => void> = []
  const api: UiApi = {
    ...mock,
    request,
    isMock: false,
    subscribe: (listener) =>
      mock.subscribe((event: UiEventEnvelope) => {
        if (deferEvents) queued.push(() => listener(structuredClone(event)))
        else listener(event)
      }),
  }
  return {
    mock,
    api,
    flushEvents: () => {
      for (const deliver of queued.splice(0)) deliver()
    },
  }
}
const readyHook = async (deferEvents = false) => {
  const { mock, api, flushEvents } = fixtureApi(deferEvents)
  const hook = renderHook(({ client }) => useWorkspace(client), { initialProps: { client: api } })
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  return { ...hook, mock, api, flushEvents }
}
const message = (parts: Message["parts"]): Message => ({
  id: "reply",
  threadId: "thread-r2",
  parentId: null,
  role: "assistant",
  kind: "text",
  status: "complete",
  runId: "run-r2",
  text: "Resposta real",
  parts,
  sender: null,
  source: "local",
  createdAt: 1,
  updatedAt: 1,
})
const run = (trigger: Run["trigger"], status: Run["status"]): Run => ({
  id: "run-r2",
  threadId: "thread-r2",
  botId: "bot-r2",
  provider: "claude",
  trigger,
  status,
  routineRunId: null,
  requestMessageId: null,
  replyMessageId: "reply",
  externalTurnId: null,
  errorClass: null,
  errorMessage: null,
  usage: null,
  queuedAt: 1,
  startedAt: 1,
  providerStartedAt: Date.now(),
  finishedAt: status === "running" ? null : 2,
})
const thread: Thread = {
  id: "thread-r2",
  botId: "bot-r2",
  title: "Conversa",
  kind: "routine",
  parentThreadId: null,
  routineRunId: null,
  activeLeafId: null,
  cwdOverride: null,
  unread: 0,
  carryoverNote: null,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costUsd: null,
    turns: 0,
    contextTokens: null,
    contextWindow: null,
  },
  source: "local",
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
}

describe("r2 regressions", () => {
  it("guest browser tab events appear, update and close without a workspace reload", async () => {
    const hook = await readyHook()
    const tab = {
      tabId: "guest",
      ownerBotId: "bot-onb",
      url: "https://touri.ai/",
      title: "touri.ai",
      state: "live" as const,
      openerTabId: null,
      heldByUser: false,
      lastUsedAt: 1,
    }
    act(() => hook.mock.emit({ type: "browser.tab", tab }))
    expect(hook.result.current.data.browserTabs).toContainEqual(tab)
    act(() => hook.mock.emit({ type: "browser.tab", tab: { ...tab, title: "Atualizada" } }))
    expect(hook.result.current.data.browserTabs.filter((entry) => entry.tabId === "guest")).toEqual([
      { ...tab, title: "Atualizada" },
    ])
    act(() => hook.mock.emit({ type: "browser.tab", tab: { ...tab, state: "closed" } }))
    expect(hook.result.current.data.browserTabs.some((entry) => entry.tabId === "guest")).toBe(false)
  })
  it("P1: refreshes Cron in place and preserves bot, conversation, filter and navigation", async () => {
    const { api, mock } = fixtureApi()
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    fireEvent.click(screen.getByRole("button", { name: /onb.*Operations/ }))
    await screen.findByRole("textbox", { name: "Mensagem para onb" })
    openRoutines("onb")
    fireEvent.click(await screen.findByRole("button", { name: "Pausadas" }))
    const count = mock.calls.filter((call) => call.route === "GET /routines").length
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Atualizar" })))
    await waitFor(() => expect(mock.calls.filter((call) => call.route === "GET /routines").length).toBe(count + 1))
    expect(screen.getByRole("heading", { name: "Rotinas" })).toBeVisible()
    expect(screen.getByRole("button", { name: "Pausadas" })).toHaveClass("active")
    fireEvent.click(screen.getByRole("button", { name: /Criar rotina/ }))
    expect(screen.getByLabelText("Bot")).toHaveValue("bot-onb")
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }))
    fireEvent.click(screen.getByRole("button", { name: /^Bots/ }))
    expect(screen.getByRole("textbox", { name: "Mensagem para onb" })).toBeVisible()
  })

  it("P1: reconnects a replaced API without resetting the current selection", async () => {
    const hook = await readyHook()
    act(() => hook.result.current.actions.selectBot("bot-onb"))
    await act(async () => hook.result.current.actions.createThread())
    const selected = hook.result.current.data.selectedThreadId
    const reads = hook.mock.calls.filter((call) => call.route === "GET /bots").length
    hook.rerender({ client: { ...hook.api } })
    await waitFor(() => expect(hook.mock.calls.filter((call) => call.route === "GET /bots").length).toBe(reads + 1))
    await waitFor(() => expect(hook.result.current.data.selectedThreadId).toBe(selected))
    expect(hook.result.current.data.selectedBotId).toBe("bot-onb")
    expect(hook.result.current.data.threads.find((item) => item.id === selected)).toBeDefined()
  })

  it("refreshes processes in the selected VM and ignores a late response from another machine", async () => {
    const fixture = fixtureApi()
    await fixture.api.request("PATCH /bots/:id", { machine: "vm" }, { id: "bot-onb" })
    const host = (await fixture.api.request("GET /projects/:id/processes", {}, { id: "project-demo" })).processes
    const guest = host.map((entry) => ({
      ...entry,
      spec: { ...entry.spec, id: `vm-${entry.spec.id}`, vmBotId: "bot-onb" },
    }))
    let delayedHost: ((value: ApiRoutes["GET /projects/:id/processes"]["res"]) => void) | undefined
    const processRequests: Array<ApiRoutes["GET /projects/:id/processes"]["req"]> = []
    const request: ApiRequest = async (route, input, path) => {
      if (route === "GET /projects/:id/processes") {
        const scope = input as ApiRoutes["GET /projects/:id/processes"]["req"]
        processRequests.push(scope)
        const response = scope.vmBotId
          ? { processes: guest }
          : await new Promise<ApiRoutes["GET /projects/:id/processes"]["res"]>((resolve) => {
              delayedHost = resolve
            })
        return response as ApiRoutes[typeof route]["res"]
      }
      return fixture.api.request(route, input, path)
    }
    const api: UiApi = { ...fixture.api, request }
    const hook = renderHook(() => useWorkspace(api))
    await waitFor(() => expect(delayedHost).toBeDefined())
    act(() => hook.result.current.actions.selectBot("bot-onb"))
    await waitFor(() => expect(hook.result.current.data.processes).toEqual(guest))
    await act(async () => delayedHost?.({ processes: host }))
    expect(hook.result.current.data.processes).toEqual(guest)
    await act(async () => hook.result.current.actions.refresh())
    await waitFor(() => expect(processRequests.at(-1)).toEqual({ vmBotId: "bot-onb" }))
    expect(hook.result.current.data.selectedBotId).toBe("bot-onb")
    expect(hook.result.current.data.processes).toEqual(guest)
    const onOpenPreview = vi.fn()
    render(
      <ProjectModal
        project={hook.result.current.data.projects[0] ?? null}
        selectedBotId="bot-onb"
        bots={hook.result.current.data.bots}
        api={api}
        invokeCommand={async () => null}
        actions={hook.result.current.actions}
        onClose={() => undefined}
        onOpenPreview={onOpenPreview}
        onNotice={vi.fn()}
      />,
    )
    await waitFor(() => expect(processRequests.at(-1)).toEqual({ vmBotId: "bot-onb" }))
    const preview = {
      projectId: "project-demo",
      processId: null,
      url: "http://localhost:4310",
      port: 4310,
      label: "web",
    }
    act(() => fixture.mock.emit({ type: "preview.available", preview }))
    expect(onOpenPreview).not.toHaveBeenCalled()
    act(() => fixture.mock.emit({ type: "preview.available", preview: { ...preview, vmBotId: "bot-onb" } }))
    expect(onOpenPreview).toHaveBeenCalledOnce()
  })

  it.each(["event-first", "response-first"])(
    "P2: reconciles server IDs for bots, conversations and crons (%s)",
    async (order) => {
      const hook = await readyHook(order === "response-first")
      const later: Array<Parameters<typeof hook.mock.emit>[0]> = []
      const originalEmit = hook.mock.emit
      // Use an explicit event replay as well as the mock's in-request event.
      await act(async () => {
        await hook.result.current.actions.createBot({ name: "seo-r2", provider: "claude" })
        const bot = hook.result.current.data.bots.find((item) => item.name === "seo-r2")
        if (bot) later.push({ type: "bot.updated", bot })
      })
      act(() => hook.flushEvents())
      const bot = hook.result.current.data.bots.find((item) => item.name === "seo-r2") as Bot
      const main = hook.result.current.data.threads.find((item) => item.botId === bot.id) as Thread
      if (order === "response-first") act(() => originalEmit({ type: "thread.updated", thread: main }))
      await act(async () => {
        await hook.result.current.actions.createThread()
        await hook.result.current.actions.createRoutine({
          botId: bot.id,
          name: "SEO semanal",
          prompt: "Leia as rotas",
          cron: "0 9 * * 1",
          timezone: "America/Sao_Paulo",
          enabled: false,
          continuity: "main-thread",
          resultsThreadId: null,
          timeoutMinutes: 30,
          overlap: "skip",
          catchUpMinutes: 30,
        })
      })
      const routine = hook.result.current.data.routines.find((item) => item.name === "SEO semanal")
      act(() => {
        hook.flushEvents()
        for (const event of later) originalEmit(event)
        if (routine) originalEmit({ type: "routine.updated", routine, lastRun: null })
        originalEmit({ type: "thread.updated", thread: main })
      })
      expect(hook.result.current.data.bots.filter((item) => item.id === bot.id)).toHaveLength(1)
      expect(hook.result.current.data.threads.filter((item) => item.botId === bot.id)).toHaveLength(2)
      expect(hook.result.current.data.routines.filter((item) => item.name === "SEO semanal")).toHaveLength(1)
    },
  )

  it("P3/P4/P5: preview uses only the selected bot project and defaults project access to that bot", async () => {
    const { api } = fixtureApi()
    await api.request("PATCH /bots/:id", { projectId: null }, { id: "bot-mark" })
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    if (!screen.queryByRole("button", { name: "Preview do projeto" }))
      fireEvent.click(screen.getByRole("button", { name: "Painel do bot" }))
    fireEvent.click(screen.getByRole("button", { name: "Preview do projeto" }))
    await screen.findByRole("heading", { name: "Preview", exact: true })

    expect(screen.getAllByText("Nenhum projeto para mark").length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toMatch(
      /sim, nesse ambiente|Subi os processos|\[PORTA\]|\[Cartão\]|\[Tabela|Admin demo/,
    )
    expect(document.querySelector(".preview-process-entry")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Conectar" }))
    const dialog = screen.getByRole("dialog", { name: "Conectar projeto" })
    const checked = within(dialog)
      .getAllByRole("checkbox")
      .filter((item) => (item as HTMLInputElement).checked)
    expect(checked).toHaveLength(1)
    expect(checked[0]?.closest("label")?.textContent).toContain("mark")
    fireEvent.click(within(dialog).getByRole("button", { name: "Fechar diálogo" }))
    fireEvent.click(screen.getByRole("button", { name: /onb.*Operations/ }))
    expect(
      await screen.findByText("touri demo workspace", { selector: ".project-sidebar-heading strong" }),
    ).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: /mark.*Campaign lead/ }))
    expect(screen.getAllByText("Nenhum projeto para mark").length).toBeGreaterThan(0)
  })

  it("P6: shows parameters and result for tools and commands, with redaction and expandable truncation", () => {
    render(
      <VirtualMessageList
        messages={[
          message([
            {
              type: "tool_call",
              callId: "bash",
              tool: "Bash",
              summary: "Claude tool Bash",
              inputJson: '{"command":"ls src/app","token":"do-not-show"}',
              outputJson: `23 rotas\n${"a".repeat(1500)}END-RESULT`,
              ok: true,
            },
            {
              type: "command",
              callId: "codex",
              command: "cat README.md",
              cwd: "/tmp/project",
              outputTail: "API_TOKEN=hide-this\nREADME real",
              exitCode: 0,
            },
          ]),
        ]}
        onSwitchBranch={() => undefined}
        onRetry={async () => undefined}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /2 ações/ }))
    const commands = screen.getAllByRole("figure", { name: "Comando" })
    expect(commands[0]).toHaveTextContent("ls src/app")
    expect(commands[1]).toHaveTextContent("cat README.md")
    for (const result of screen.getAllByText("Resultado")) fireEvent.click(result)
    expect(screen.getByText(/README real/)).toBeVisible()
    expect(document.body.textContent).not.toMatch(/do-not-show|hide-this|END-RESULT/)
    fireEvent.click(screen.getByRole("button", { name: "Mostrar saída completa" }))
    expect(screen.getByText(/END-RESULT/)).toBeVisible()
  })

  it("P8: create and settings save the role and optional title without touching SOUL", async () => {
    const onCreate = vi.fn(async (_input: ApiRoutes["POST /bots"]["req"]) => undefined)
    const modal = render(<BotCreateModal onCreate={onCreate} onClose={() => undefined} />)
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "seo" } })
    fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
    fireEvent.change(screen.getByLabelText("Função"), { target: { value: "SEO do site" } })
    fireEvent.change(screen.getByLabelText("Título (opcional)"), { target: { value: "Analista" } })
    fireEvent.click(screen.getByRole("button", { name: "Criar bot" }))
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ roleLine: "SEO do site", title: "Analista" })),
    )
    modal.unmount()
    const hook = await readyHook()
    const bot = hook.result.current.data.bots[0] as Bot
    const update = vi.fn(async () => undefined)
    render(
      <BotSettingsModal
        bot={{ ...bot, roleLine: "SEO do site", title: "Analista" }}
        projects={[]}
        routines={[]}
        actions={{ ...hook.result.current.actions, updateBot: update }}
        onClose={() => undefined}
      />,
    )
    expect(screen.getByLabelText("O que ele faz")).toHaveValue("SEO do site")
    fireEvent.change(screen.getByLabelText("O que ele faz"), { target: { value: "Touri · Coder" } })
    fireEvent.click(screen.getByRole("button", { name: "Salvar configurações" }))
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        bot.id,
        expect.objectContaining({ roleLine: "Touri · Coder", title: "Analista", instructions: bot.instructions }),
      ),
    )
  })

  it.each(["main", "routine"] as const)("P9: user turns in %s threads never render routine run copy", (kind) => {
    const api = fixtureApi().api
    const view = render(
      <ChatPanel
        thread={{ ...thread, kind }}
        bot={null}
        messages={[{ ...message([]), status: "streaming" }]}
        runs={[run("user", "running")]}
        onSend={async () => undefined}
        onRetry={async () => undefined}
        onCancel={async () => undefined}
        onSwitchBranch={async () => undefined}
        computerGrant={null}
        api={api}
        onComputerGrant={() => undefined}
        onOpenTools={() => undefined}
      />,
    )
    expect(screen.getByText("Trabalhando…")).toBeVisible()
    expect(document.querySelector(".run-card")).toBeNull()
    view.rerender(
      <ChatPanel
        thread={{ ...thread, kind }}
        bot={null}
        messages={[message([])]}
        runs={[run("user", "succeeded")]}
        onSend={async () => undefined}
        onRetry={async () => undefined}
        onCancel={async () => undefined}
        onSwitchBranch={async () => undefined}
        computerGrant={null}
        api={api}
        onComputerGrant={() => undefined}
        onOpenTools={() => undefined}
      />,
    )
    expect(document.body.textContent).not.toContain("A rotina")
  })

  it("P9: a routine trigger still renders the routine card", () => {
    render(
      <ChatPanel
        thread={thread}
        bot={null}
        messages={[]}
        runs={[run("routine", "succeeded")]}
        onSend={async () => undefined}
        onRetry={async () => undefined}
        onCancel={async () => undefined}
        onSwitchBranch={async () => undefined}
        computerGrant={null}
        api={fixtureApi().api}
        onComputerGrant={() => undefined}
        onOpenTools={() => undefined}
      />,
    )
    expect(document.querySelector(".routine-run-marker")).toHaveTextContent("Concluído")
    expect(screen.queryByText("A rotina terminou e deixou o resultado nesta conversa.")).toBeNull()
  })

  it("P10: defaults to Portuguese, keeps English, and shows notification status once", async () => {
    expect(t("Save settings")).toBe("Salvar configurações")
    expect(t("Save settings", {}, "en")).toBe("Save settings")
    expect(Object.keys(dictionaries.en)).toEqual(Object.keys(dictionaries["pt-BR"]))
    const { api, mock } = fixtureApi()
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    act(() => mock.notify({ kind: "done", title: "Done", body: "Resposta real", botId: "bot-mark" }))
    fireEvent.click(screen.getByRole("button", { name: "Notificações" }))
    const popover = screen.getByRole("region", { name: "Central de notificações" })
    expect(within(popover).getAllByText("Concluído")).toHaveLength(1)
    expect(popover.textContent).not.toContain("Done")
  })
})

it("P1: waits for endpoint readiness without issuing requests through the unavailable API", () => {
  const request = vi.fn(async () => {
    throw new Error("sidecar is not connected")
  })
  const api: UiApi = { request, subscribe: () => () => undefined, isMock: false }
  const hook = renderHook(() => useWorkspace(api, false))
  expect(request).not.toHaveBeenCalled()
  expect(hook.result.current.data.notice).toBeNull()
})

it("P2: normalizes duplicate IDs in a REST snapshot", async () => {
  const fixture = fixtureApi()
  const request: ApiRequest = async (route, input, path) => {
    const response = await fixture.api.request(route, input, path)
    if (route === "GET /bots") {
      const { bots } = response as ApiRoutes["GET /bots"]["res"]
      return { bots: [...bots, ...bots] } as ApiRoutes[typeof route]["res"]
    }
    return response
  }
  const api: UiApi = { ...fixture.api, request }
  const hook = renderHook(() => useWorkspace(api))
  await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
  expect(hook.result.current.data.bots).toHaveLength(3)
  expect(hook.result.current.data.threads).toHaveLength(2)
})

it.each(["queued", "starting"] as const)(
  "keeps the provider-start phase after a late %s acceptance snapshot",
  async (status) => {
    const fixture = fixtureApi()
    let release: ((value: ApiRoutes["POST /threads/:id/messages"]["res"]) => void) | undefined
    const request: ApiRequest = async (route, input, path) => {
      if (route === "POST /threads/:id/messages")
        return (await new Promise<ApiRoutes["POST /threads/:id/messages"]["res"]>((resolve) => {
          release = resolve
        })) as ApiRoutes[typeof route]["res"]
      return fixture.api.request(route, input, path)
    }
    const api: UiApi = { ...fixture.api, request }
    const hook = renderHook(() => useWorkspace(api))
    await waitFor(() => expect(hook.result.current.data.loading).toBe(false))
    const thread = hook.result.current.data.threads.find((row) => row.id === hook.result.current.data.selectedThreadId)
    if (!thread?.botId) throw new Error("Missing selected conversation")
    const started: Run = {
      ...run("user", "starting"),
      id: "phase-run",
      threadId: thread.id,
      botId: thread.botId,
      requestMessageId: "phase-request",
      providerStartedAt: Date.now(),
      finishedAt: null,
    }
    let sending: Promise<void> | undefined
    act(() => {
      sending = hook.result.current.actions.sendMessage("Organize minhas notas.")
    })
    await waitFor(() => expect(release).toBeDefined())
    act(() => fixture.mock.emit({ type: "run.updated", run: started }))
    expect(hook.result.current.data.runs.find((row) => row.id === started.id)?.providerStartedAt).toBe(
      started.providerStartedAt,
    )
    const stale: Run = { ...started, status }
    delete stale.providerStartedAt
    await act(async () => {
      release?.({
        message: {
          ...message([]),
          id: "phase-request",
          threadId: thread.id,
          role: "user",
          text: "Organize minhas notas.",
        },
        run: stale,
      })
      await sending
    })
    expect(hook.result.current.data.runs.find((row) => row.id === started.id)?.providerStartedAt).toBe(
      started.providerStartedAt,
    )
    expect(hook.result.current.data.runs.find((row) => row.id === started.id)?.status).toBe("starting")
  },
)
