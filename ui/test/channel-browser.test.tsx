import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import type { Bot, BotGroup, Message, Run, ToolCallPart } from "@touri/contracts"
import { useEffect } from "react"
import { afterEach, describe, expect, test, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { BrowserActivityCard } from "../src/components/BrowserActivityCard"
import { BrowserActivityControlsProvider, useBrowserActivityControls } from "../src/components/BrowserActivityControls"
import { ChatPanel } from "../src/components/ChatPanel"
import { GroupHeader, GroupSidebar } from "../src/components/Groups"
import { ChannelBrowserContext, ChannelComposerChip } from "../src/features/channelBrowser/ChannelBrowser"
import {
  type ChannelBrowserState,
  getChannelBrowserView,
  getChannelQueueLabel,
  getChannelWorking,
} from "../src/features/channelBrowser/channelBrowserModel"
import { InlinePreviewContext } from "../src/features/desktop/InlineLivePreview"

vi.mock("../src/features/desktop/inlineFrameSource", () => ({
  startInlineFrameSource: vi.fn(
    (
      _api: unknown,
      _bot: unknown,
      _tab: unknown,
      frame: (value: { src: string; title: string; url: string }) => void,
    ) => {
      frame({ src: "data:image/jpeg;base64,ZmFrZQ==", title: "Estadias", url: "https://estadias.example.test/busca" })

      return () => {}
    },
  ),
}))

afterEach(cleanup)

const getState = (patch: Partial<ChannelBrowserState> = {}): ChannelBrowserState => ({
  botId: "bot-leo",
  botName: "Léo",
  requesterId: "user-ana",
  requesterName: "Ana",
  controllerId: null,
  controllerName: null,
  ownerId: "user-owner",
  queue: [],
  ...patch,
})

const getPart = (callId: string, tool: string, inputJson: string): ToolCallPart => ({
  type: "tool_call",
  callId,
  tool,
  inputJson,
  summary: "browser action",
  outputJson: null,
  ok: true,
})

const browserParts = [
  getPart("open", "mcp__touri__browser_open", '{"url":"https://estadias.example.test/busca"}'),
  getPart("click", "mcp__touri__browser_click", '{"tabId":"tab-1","target":{"name":"Chicago"}}'),
]

const RegisterTakeoverAction = ({ onTakeover }: { onTakeover: () => void }) => {
  const controls = useBrowserActivityControls()
  useEffect(
    () => controls.registerTakeover({ label: "Assumir", run: onTakeover }),
    [controls.registerTakeover, onTakeover],
  )

  return null
}

const getMessage = (overrides: Partial<Message> = {}): Message => ({
  id: "prompt",
  threadId: "thread-channel",
  parentId: null,
  role: "user",
  kind: "text",
  status: "complete",
  runId: null,
  text: "Pesquise estadias em Chicago.",
  parts: [{ type: "text", text: "Pesquise estadias em Chicago." }],
  sender: null,
  source: "local",
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

const getRun = (threadId: string, bot: Bot): Run => ({
  id: "run-channel",
  botId: bot.id,
  threadId,
  provider: bot.provider,
  trigger: "user",
  requestMessageId: "prompt",
  replyMessageId: "reply",
  externalTurnId: null,
  status: "running",
  errorClass: null,
  errorMessage: null,
  usage: null,
  routineRunId: null,
  queuedAt: 1,
  startedAt: 1,
  finishedAt: null,
})

const renderCard = (state: ChannelBrowserState, viewerId: string) => {
  const api = createMockApi()
  const bot = api.getState().bots[0] ?? null

  return render(
    <ChannelBrowserContext.Provider value={{ state, viewerId }}>
      <InlinePreviewContext.Provider
        value={{ api, bot, machine: undefined, activeCallId: undefined, onOpenComputer: vi.fn() }}
      >
        <BrowserActivityCard parts={browserParts} finished={false} createdAt={1} botName="Léo" />
      </InlinePreviewContext.Provider>
    </ChannelBrowserContext.Provider>,
  )
}

describe("getChannelBrowserView", () => {
  test("lets the requester and the bot owner control, nobody else", () => {
    const state = getState()

    expect(getChannelBrowserView(state, "user-ana").canControl).toBe(true)
    expect(getChannelBrowserView(state, "user-owner").canControl).toBe(true)
    expect(getChannelBrowserView(state, "user-hugo").canControl).toBe(false)
  })

  test("names the requester as in control while the bot works", () => {
    const view = getChannelBrowserView(getState(), "user-hugo")

    expect(view.controlName).toBe("Ana")
    expect(view.previewHidden).toBe(false)
  })

  test("hides the preview for everyone but the controller during a take-over", () => {
    const state = getState({ controllerId: "user-ana", controllerName: "Ana" })

    expect(getChannelBrowserView(state, "user-hugo").previewHidden).toBe(true)
    expect(getChannelBrowserView(state, "user-owner").previewHidden).toBe(true)
    expect(getChannelBrowserView(state, "user-ana").previewHidden).toBe(false)
  })

  test("names the controller when someone took over", () => {
    const state = getState({ controllerId: "user-owner", controllerName: "Bia" })

    expect(getChannelBrowserView(state, "user-hugo").controlName).toBe("Bia")
  })
})

describe("getChannelWorking", () => {
  test("marks only group rows with a live browser action", () => {
    const messages = [
      getMessage({
        id: "reply",
        threadId: "group-thread",
        role: "assistant",
        status: "streaming",
        sender: { id: "bot-leo", name: "Léo" },
        parts: [{ ...browserParts[0], ok: null, outputJson: null }],
      }),
      getMessage({
        id: "idle",
        threadId: "group-thread",
        role: "assistant",
        status: "complete",
        sender: { id: "bot-ana", name: "AnaBot" },
        parts: browserParts,
      }),
      getMessage({
        id: "direct",
        threadId: "direct-thread",
        role: "assistant",
        status: "streaming",
        sender: { id: "bot-mark", name: "Mark" },
        parts: [{ ...browserParts[0], ok: null, outputJson: null }],
      }),
    ]

    const working = getChannelWorking(
      [
        { id: "group-thread", groupId: "group-viagens" },
        { id: "direct-thread", groupId: null },
      ],
      messages,
    )

    expect(working).toEqual({ "group-viagens": ["Léo"] })
  })
})

describe("getChannelQueueLabel", () => {
  test("is empty without a queue", () => {
    expect(getChannelQueueLabel([], "pt-BR")).toBe("")
  })

  test("names the next request and counts the rest", () => {
    const queue = [
      { requesterId: "user-hugo", requesterName: "Hugo" },
      { requesterId: "user-bia", requesterName: "Bia" },
    ]

    expect(getChannelQueueLabel(queue.slice(0, 1), "pt-BR")).toBe("Na fila: pedido de Hugo")
    expect(getChannelQueueLabel(queue, "pt-BR")).toBe("Na fila: pedido de Hugo · mais 1")
  })
})

describe("browser card in a channel", () => {
  test("tells everyone in the channel and explains login before the requester", () => {
    renderCard(getState(), "user-ana")

    expect(screen.getByText("Todos no canal veem")).toBeVisible()
    expect(screen.getByText(/Léo pausa e chama Ana, quem pediu/)).toBeVisible()
  })

  test("hides Assumir from people who are not allowed to take control", () => {
    renderCard(getState(), "user-hugo")

    expect(screen.queryByRole("button", { name: /Assumir/ })).toBeNull()
    expect(screen.getByText("Ana está no controle")).toBeVisible()
  })

  test("keeps Assumir enabled for the requester", () => {
    renderCard(getState(), "user-ana")

    expect(screen.getByRole("button", { name: /Assumir/ })).toBeEnabled()
  })

  test("hides the preview for the channel while someone has control", () => {
    renderCard(getState({ controllerId: "user-ana", controllerName: "Ana" }), "user-hugo")

    expect(screen.queryByRole("img", { name: "Página atual do navegador" })).toBeNull()
    expect(screen.getByText("Prévia oculta para o canal enquanto Ana digita")).toBeVisible()
  })

  test("shows the queued request below the card", () => {
    renderCard(getState({ queue: [{ requesterId: "user-hugo", requesterName: "Hugo" }] }), "user-ana")

    expect(screen.getByText("Na fila: pedido de Hugo")).toBeVisible()
  })

  test("stays unchanged outside a channel", () => {
    const api = createMockApi()
    render(
      <InlinePreviewContext.Provider
        value={{ api, bot: null, machine: undefined, activeCallId: undefined, onOpenComputer: vi.fn() }}
      >
        <BrowserActivityCard parts={browserParts} finished={false} createdAt={1} botName="Léo" />
      </InlinePreviewContext.Provider>,
    )

    expect(screen.queryByText("Todos no canal veem")).toBeNull()
  })
})

describe("channel chrome", () => {
  const api = createMockApi()
  const bots = api.getState().bots.slice(0, 2) as Bot[]
  const group = {
    id: "group-viagens",
    name: "viagens",
    color: "#dc2626",
    avatarShape: "classic-none",
    avatarSeed: "s",
    memberIds: bots.map((bot) => bot.id),
    coordinatorBotId: null,
  } as unknown as BotGroup

  test("header chip names the bot and the requester", () => {
    render(
      <ChannelBrowserContext.Provider value={{ state: getState(), viewerId: "user-hugo" }}>
        <GroupHeader group={group} bots={bots} onEdit={() => {}} />
      </ChannelBrowserContext.Provider>,
    )

    const chip = screen.getByRole("status", { name: "Léo no navegador · pedido de Ana" })

    expect(chip).toBeVisible()
  })

  test("header has no chip when nobody works in the browser", () => {
    render(<GroupHeader group={group} bots={bots} onEdit={() => {}} />)

    expect(screen.queryByRole("status", { name: /no navegador/ })).toBeNull()
  })

  test("sidebar marks the channel row with the working bot", () => {
    render(
      <GroupSidebar
        groups={[group]}
        bots={bots}
        threads={[]}
        selectedThreadId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onEdit={() => {}}
        onNewThread={() => {}}
        channelWorking={{ [group.id]: ["Léo"] }}
      />,
    )

    const row = screen.getByRole("button", { name: "viagens" }).closest(".group-sidebar-row") as HTMLElement

    expect(within(row).getByTitle("Léo trabalhando aqui")).toBeVisible()
  })

  test("composer chip tells bystanders who has browser control", () => {
    render(
      <ChannelBrowserContext.Provider value={{ state: getState(), viewerId: "user-hugo" }}>
        <ChannelComposerChip botName="Léo" />
      </ChannelBrowserContext.Provider>,
    )

    expect(screen.getByRole("status")).toHaveTextContent("Ana está no controle")
  })

  test("composer chip stops the active browser run", () => {
    const onStop = vi.fn()
    render(<ChannelComposerChip botName="Léo" onStop={onStop} />)

    fireEvent.click(screen.getByRole("button", { name: "Parar Léo" }))

    expect(onStop).toHaveBeenCalledOnce()
  })

  test("only channel controllers get a takeover action in the composer chip", async () => {
    const onTakeover = vi.fn()
    const view = render(
      <BrowserActivityControlsProvider>
        <ChannelBrowserContext.Provider value={{ state: getState(), viewerId: "user-ana" }}>
          <RegisterTakeoverAction onTakeover={onTakeover} />
          <ChannelComposerChip botName="Léo" />
        </ChannelBrowserContext.Provider>
      </BrowserActivityControlsProvider>,
    )
    const takeOver = await screen.findByRole("button", { name: "Assumir" })

    fireEvent.click(takeOver)
    expect(onTakeover).toHaveBeenCalledOnce()

    view.rerender(
      <BrowserActivityControlsProvider>
        <ChannelBrowserContext.Provider value={{ state: getState(), viewerId: "user-hugo" }}>
          <RegisterTakeoverAction onTakeover={onTakeover} />
          <ChannelComposerChip botName="Léo" />
        </ChannelBrowserContext.Provider>
      </BrowserActivityControlsProvider>,
    )

    expect(screen.queryByRole("button", { name: "Assumir" })).toBeNull()
    expect(screen.getByRole("status")).toHaveTextContent("Ana está no controle")
  })
})

test("ChatPanel shares channel browser state with the group header, reply card, and composer", async () => {
  const api = createMockApi()
  const bot = api.getState().bots.find((item) => item.id === "bot-mark")
  if (!bot) throw new Error("Missing fixture bot")
  const { group, thread } = await api.request("POST /groups", {
    name: "viagens",
    color: "#dc2626",
    avatarShape: "classic-none",
    memberIds: [bot.id],
    coordinatorBotId: null,
  })
  const prompt = getMessage({ threadId: thread.id })
  const reply = getMessage({
    id: "reply",
    threadId: thread.id,
    parentId: prompt.id,
    role: "assistant",
    status: "streaming",
    runId: "run-channel",
    text: "Estou na página de estadias.",
    parts: [{ ...browserParts[0], ok: null, outputJson: null }],
    sender: { id: bot.id, name: "Léo" },
    createdAt: 2,
  })

  render(
    <ChatPanel
      group={group}
      groupMembers={[bot]}
      channelBrowser={{ state: getState({ botId: bot.id, botName: "Léo" }), viewerId: "user-ana" }}
      thread={{ ...thread, activeLeafId: reply.id }}
      bot={bot}
      messages={[prompt, reply]}
      runs={[getRun(thread.id, bot)]}
      onSend={vi.fn(async () => {})}
      onRetry={vi.fn(async () => {})}
      onCancel={vi.fn(async () => {})}
      onSwitchBranch={vi.fn(async () => {})}
      computerGrant={null}
      api={api}
      onComputerGrant={vi.fn()}
      onOpenTools={vi.fn()}
    />,
  )

  expect(screen.getByRole("status", { name: "Léo no navegador · pedido de Ana" })).toBeVisible()
  expect(await screen.findByText("Todos no canal veem")).toBeVisible()
  expect(screen.getByText("Léo está trabalhando · No navegador · para Ana")).toBeVisible()
  expect(screen.getByText("Todos no canal veem").closest(".message-assistant")).toContainElement(
    screen.getByText("Estou na página de estadias."),
  )
})
