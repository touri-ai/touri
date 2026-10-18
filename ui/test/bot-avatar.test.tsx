import { BotEngine, EXPRESSION_BY_ID, SHAPES, STATE_BY_ID } from "@norbert_bodziony/bloub"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { Bot, Message, NotificationRecord, Run } from "@touri/contracts"
import {
  AVATAR_STATES,
  avatarHasClock,
  avatarMoodFor,
  avatarProfileFor,
  createAvatarEngine,
  renderAvatarSvg,
  setAvatarState,
} from "@touri/contracts/avatar"
import { afterEach, describe, expect, it, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { type AvatarRuntime, AvatarRuntimeProvider } from "../src/components/AvatarRuntime"
import { BotAvatar } from "../src/components/BotAvatar"
import { BotCreateModal, BotSettingsModal } from "../src/components/Modals"
import type { WorkspaceActions } from "../src/useWorkspace"
import { openRoutines } from "./workspaceNavigation"

const bot = { id: "avatar-test", color: null, name: "Test", avatarShape: "triangle" as const }
const run = (status: Run["status"], at = 9000): Run => ({
  id: "run",
  botId: bot.id,
  threadId: "thread",
  provider: "codex",
  trigger: "user",
  requestMessageId: null,
  replyMessageId: "reply",
  externalTurnId: null,
  status,
  errorClass: null,
  errorMessage: null,
  usage: null,
  routineRunId: null,
  queuedAt: at,
  startedAt: at,
  finishedAt: at,
})
const notification = (kind: NotificationRecord["kind"], resolvedAt: number | null = null): NotificationRecord => ({
  id: 1,
  botId: bot.id,
  botName: bot.name,
  botColor: "#ff8833",
  avatarShape: "triangle",
  threadId: "thread",
  kind,
  level: "warning",
  title: "Attention",
  body: "Question?",
  requestId: "request",
  createdAt: 9000,
  resolvedAt,
  resolution: null,
})
const runtime = (runs: Run[]): AvatarRuntime => ({
  bots: [],
  runs,
  messages: [],
  threads: [],
  notifications: [],
  loading: false,
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("procedural avatars", () => {
  it("reuses every SVG mask and path across a thousand animation frames", () => {
    let tick: FrameRequestCallback = () => undefined
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      tick = callback
      return 1
    })
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined)
    vi.spyOn(document, "hidden", "get").mockReturnValue(false)
    const { container } = render(<BotAvatar bot={bot} mood="working" />)
    const svg = container.querySelector("svg")
    if (!svg) throw new Error("Missing avatar SVG")
    const original = [...svg.querySelectorAll("*")]
    const initialPath = svg.querySelector("mask > path")?.getAttribute("d")
    for (let frame = 1; frame <= 1000; frame++) act(() => tick(frame * 35))
    const next = [...svg.querySelectorAll("*")]
    expect(next).toHaveLength(original.length)
    next.forEach((node, index) => {
      expect(node).toBe(original[index])
    })
    expect(svg.querySelector("mask > path")?.getAttribute("d")).not.toBe(initialPath)
  })
  it("derives stable and varied profiles from seeds, independent of bot names and ids", () => {
    const profile = avatarProfileFor({ id: "one", color: null, avatarSeed: "fixed" })
    expect(profile).toEqual(avatarProfileFor({ id: "two", color: null, avatarSeed: "fixed" }))
    expect(profile).toMatchObject({ shape: "squircle", expression: "somnolent" })
    expect(
      new Set(Array.from({ length: 60 }, (_, id) => avatarProfileFor({ id: String(id), color: null }).shape)).size,
    ).toBe(7)
    expect(avatarProfileFor({ ...bot, color: "#123456" })).toMatchObject({ shape: "triangle", color: "#123456" })
  })
  it("maps runtime signals and gives pending requests precedence over work", () => {
    const mood = (input: Partial<Parameters<typeof avatarMoodFor>[0]>) => avatarMoodFor({ botId: bot.id, ...input })
    expect(mood({})).toBe("idle")
    for (const status of ["queued", "starting", "running"] as const)
      expect(mood({ runs: [run(status)] })).toBe("working")
    expect(mood({ runs: [run("failed")] })).toBe("failed")
    expect(mood({ recentReply: true })).toBe("responded")
    expect(mood({ runs: [run("succeeded", 4999)] })).toBe("idle")
    expect(mood({ runs: [run("succeeded", 5000)] })).toBe("idle")
    expect(mood({ paused: true, runs: [run("running")] })).toBe("asleep")
    expect(mood({ connecting: true })).toBe("connecting")
    for (const kind of ["approval", "question"] as const) {
      expect(mood({ runs: [run("running")], notifications: [notification(kind)] })).toBe("waiting")
      expect(mood({ notifications: [notification(kind, 9500)] })).toBe("idle")
    }
    expect(mood({ runs: [run("failed", 8000), run("running", 9000)] })).toBe("working")
    expect(mood({ runs: [{ ...run("failed"), botId: "other" }] })).toBe("idle")
    expect(mood({ messages: [{ parts: [{ type: "approval", decision: "pending" }] } as Message] })).toBe("waiting")
  })
  it("uses only silhouette-safe states and keeps the chosen body during work", () => {
    expect(AVATAR_STATES.every((id) => STATE_BY_ID.get(id)?.baseBody)).toBe(true)
    for (const shape of SHAPES) {
      const profile = avatarProfileFor({ ...bot, avatarShape: shape.id })
      const engine = createAvatarEngine(profile, "working")
      const active = engine.sample(0.7)
      expect(active.bodyPath).toBe(createAvatarEngine(profile, "idle").sample(0.7).bodyPath)
      expect(active.arcs).toHaveLength(0)
      expect(() => setAvatarState(engine, "orbit", 0)).toThrow("Unsafe avatar state")
    }
  })
  it("glides expressions and exports a safe, deterministic static SVG", () => {
    const profile = avatarProfileFor(bot)
    const engine = createAvatarEngine(profile, "idle")
    engine.setExpression(EXPRESSION_BY_ID.get("triste") ?? null, 1)
    expect(engine.sample(1).eyes).not.toEqual(engine.sample(1 + BotEngine.SHAPE_MORPH).eyes)
    expect(renderAvatarSvg(bot)).toBe(renderAvatarSvg(bot))
    expect(renderAvatarSvg({ ...bot, color: "<script>alert(1)</script>" })).not.toContain("<script>")
    expect(renderAvatarSvg(bot, { size: 24, mood: "failed" })).toContain('width="24"')
  })
  it("remains still under reduced motion, updates expressions immediately, and preserves the overlay", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList)
    const raf = vi.spyOn(window, "requestAnimationFrame")
    const { container, rerender } = render(<BotAvatar bot={bot} mood="working" unread />)
    const before = container.querySelector("svg")?.innerHTML
    expect(screen.getByTitle("Não lidas")).toBeInTheDocument()
    expect(container.querySelector(".tb-avatar")).toHaveAttribute("data-avatar-animated", "false")
    fireEvent.pointerMove(window, { clientX: 400, clientY: 400 })
    expect(container.querySelector("svg")?.innerHTML).toBe(before)
    expect(raf).not.toHaveBeenCalled()
    rerender(<BotAvatar bot={bot} mood="failed" unread />)
    expect(container.querySelector("svg")?.innerHTML).not.toBe(before)
    expect(container.querySelector(".tb-avatar")).toHaveAttribute("data-avatar-expression", "triste")
    expect(raf).not.toHaveBeenCalled()
    expect(avatarHasClock("working", true)).toBe(false)
    expect(avatarHasClock("idle", false)).toBe(false)
  })
  it("holds a background reply until focus returns, and briefly celebrates focused replies", () => {
    vi.useFakeTimers()
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1)
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined)
    vi.spyOn(document, "hasFocus").mockReturnValue(false)
    const view = (runs: Run[]) => (
      <AvatarRuntimeProvider value={runtime(runs)}>
        <BotAvatar bot={bot} />
      </AvatarRuntimeProvider>
    )
    const { container, rerender } = render(view([]))
    rerender(view([run("succeeded")]))
    expect(container.querySelector(".tb-avatar")).toHaveAttribute("data-avatar-mood", "responded")
    act(() => vi.advanceTimersByTime(60000))
    expect(container.querySelector(".tb-avatar")).toHaveAttribute("data-avatar-mood", "responded")
    fireEvent.focus(window)
    expect(container.querySelector(".tb-avatar")).toHaveAttribute("data-avatar-mood", "idle")
    vi.spyOn(document, "hasFocus").mockReturnValue(true)
    rerender(view([run("succeeded", 10000)]))
    expect(container.querySelector(".tb-avatar")).toHaveAttribute("data-mascot-state", "done")
    act(() => vi.advanceTimersByTime(2400))
    expect(container.querySelector(".tb-avatar")).toHaveAttribute("data-avatar-mood", "idle")
  })
  it("shares identity and applies surface moods across chat, run cards, notifications and Cron", async () => {
    const api = createMockApi()
    const { container } = render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    await act(async () => {
      await api.request(
        "PATCH /bots/:id",
        { avatarShape: "hexagone", avatarSeed: "chosen", color: "#2468ac" },
        { id: "bot-mark" },
      )
    })
    act(() => {
      api.emit({
        type: "run.updated",
        run: { ...run("running"), trigger: "routine", botId: "bot-mark", threadId: "thread-mark" },
      })
      api.notify({ kind: "question", title: "Question", body: "Continue?", botId: "bot-mark", requestId: "pending" })
    })
    fireEvent.click(await screen.findByRole("button", { name: "Notificações, 1 precisa de atenção" }))
    const avatars = document.querySelectorAll('.tb-avatar[data-bot-id="bot-mark"]')
    expect(avatars.length).toBeGreaterThanOrEqual(4)
    for (const avatar of avatars) {
      expect(avatar).toHaveAttribute("data-avatar-shape", "hexagone")
      expect(avatar).toHaveAttribute("data-avatar-mood", "waiting")
      expect(avatar.querySelector("[data-avatar-body]")).toHaveAttribute("fill", "#2468ac")
    }
    openRoutines()
    const cronAvatar = container.querySelector('.routine-item .tb-avatar[data-bot-id="bot-mark"]')
    expect(cronAvatar).toHaveAttribute("data-avatar-shape", "hexagone")
    expect(cronAvatar).toHaveAttribute("data-avatar-mood", "waiting")
  })

  it("persists avatar and VM choices together through creation and settings", async () => {
    const api = createMockApi()
    const capability = { available: true, reason: null, provider: "apple-container" as const }
    let created: Bot | null = null
    const create = render(
      <BotCreateModal
        capability={capability}
        onClose={() => undefined}
        onCreate={async (input) => {
          created = (await api.request("POST /bots", input)).bot
        }}
      />,
    )
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Avatar bot" } })
    fireEvent.click(screen.getByRole("button", { name: "Forma Nuvem" }))
    fireEvent.click(screen.getByRole("button", { name: "Cor Azul" }))
    fireEvent.click(screen.getByRole("button", { name: "Avançado" }))
    fireEvent.change(screen.getByLabelText("Função"), { target: { value: "SEO do site" } })
    fireEvent.change(screen.getByLabelText("Título (opcional)"), { target: { value: "Analista" } })
    fireEvent.change(screen.getByLabelText("Máquina"), { target: { value: "vm" } })
    fireEvent.change(screen.getByLabelText("Parar após minutos sem atividade"), { target: { value: "30" } })
    fireEvent.click(screen.getByRole("switch", { name: /Usar meu login do Codex/ }))
    fireEvent.click(screen.getByRole("button", { name: "Criar bot" }))
    await waitFor(() =>
      expect(created).toMatchObject({
        avatarShape: "nuage",
        roleLine: "SEO do site",
        title: "Analista",
        machine: "vm",
        machineIdleMinutes: 30,
        vmProviderLogin: true,
        hostComputerUse: false,
      }),
    )
    create.unmount()
    if (!created) throw new Error("Bot was not created")
    const saved: Bot = created
    expect(saved.avatarSeed).toBeTruthy()
    const actions = {
      updateBot: async (id: string, patch: Partial<Bot>) => {
        await api.request("PATCH /bots/:id", patch, { id })
      },
    } as WorkspaceActions
    const settings = render(
      <BotSettingsModal
        bot={saved}
        capability={capability}
        projects={[]}
        routines={[]}
        actions={actions}
        onClose={() => undefined}
      />,
    )
    expect(screen.getByRole("button", { name: "Forma Nuvem" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "Cor Azul" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByLabelText("O que ele faz")).toHaveValue("SEO do site")
    fireEvent.click(screen.getByRole("button", { name: "Forma Hexágono" }))
    fireEvent.click(screen.getByRole("button", { name: "Avançado" }))
    expect(screen.getByLabelText("Título (opcional)")).toHaveValue("Analista")
    fireEvent.click(screen.getByRole("tab", { name: "Computador" }))
    expect(screen.getByLabelText("Máquina")).toHaveValue("vm")
    expect(screen.getByLabelText("Parar após minutos sem atividade")).toHaveValue(30)
    expect(screen.getByRole("switch", { name: /Usar meu login do Codex/ })).toBeChecked()
    fireEvent.change(screen.getByLabelText("Parar após minutos sem atividade"), { target: { value: "45" } })
    fireEvent.click(screen.getByRole("switch", { name: /Permitir controle do computador na tela deste Mac/ }))
    fireEvent.click(screen.getByRole("button", { name: "Salvar configurações" }))
    await waitFor(() =>
      expect(api.getState().bots.find((item) => item.id === saved.id)).toMatchObject({
        avatarShape: "hexagone",
        avatarSeed: saved.avatarSeed,
        roleLine: "SEO do site",
        title: "Analista",
        machine: "vm",
        machineIdleMinutes: 45,
        vmProviderLogin: true,
        hostComputerUse: true,
      }),
    )
    settings.unmount()
  })
})
