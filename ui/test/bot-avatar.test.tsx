import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { Bot, BotGroup, GroupInput, Message, NotificationRecord, Run } from "@touri/contracts"
import { avatarMoodFor, avatarProfileFor, renderAvatarSvg } from "@touri/contracts/avatar"
import { afterEach, describe, expect, it, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { AvatarPicker } from "../src/components/AvatarPicker"
import { type AvatarRuntime, AvatarRuntimeProvider } from "../src/components/AvatarRuntime"
import { BotAvatar } from "../src/components/BotAvatar"
import { GroupModal } from "../src/components/Groups"
import { BotCreateModal, BotSettingsModal } from "../src/components/Modals"
import type { WorkspaceActions } from "../src/useWorkspace"
import { openRoutines } from "./workspaceNavigation"

const bot = { id: "avatar-test", color: null, name: "Test", avatarShape: "long-crown" as const }
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
  avatarShape: "long-crown",
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
  it("keeps every avatar node when it re-renders with the same look and phase", () => {
    const { container, rerender } = render(<BotAvatar bot={bot} mood="working" />)
    const original = [...container.querySelectorAll("svg *")]

    rerender(<BotAvatar bot={bot} mood="working" />)

    const next = [...container.querySelectorAll("svg *")]
    expect(next).toHaveLength(original.length)
    next.forEach((node, index) => {
      expect(node).toBe(original[index])
    })
  })
  it("derives stable and varied profiles from seeds, independent of bot names and ids", () => {
    const profile = avatarProfileFor({ id: "one", color: null, avatarSeed: "fixed" })
    expect(profile).toEqual(avatarProfileFor({ id: "two", color: null, avatarSeed: "fixed" }))
    expect(profile).toMatchObject({ shape: "short-glasses", horns: "short", accessory: "glasses" })
    expect(
      new Set(Array.from({ length: 60 }, (_, id) => avatarProfileFor({ id: String(id), color: null }).horns)).size,
    ).toBe(4)
    expect(avatarProfileFor({ ...bot, color: "#123456" })).toMatchObject({ shape: "long-crown", color: "#123456" })
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
  it("exports a safe, deterministic static SVG", () => {
    expect(renderAvatarSvg(bot)).toBe(renderAvatarSvg(bot))
    expect(renderAvatarSvg({ ...bot, color: "<script>alert(1)</script>" })).not.toContain("<script>")
    expect(renderAvatarSvg(bot, { size: 24, mood: "failed" })).toContain('width="24"')
  })
  it("remains still under reduced motion, updates faces immediately, and preserves the overlay", () => {
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
    rerender(<BotAvatar bot={bot} mood="failed" unread />)
    expect(container.querySelector("svg")?.innerHTML).not.toBe(before)
    expect(container.querySelector(".tb-avatar")).toHaveAttribute("data-avatar-phase", "failed")
    expect(raf).not.toHaveBeenCalled()
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
        { avatarShape: "long-crown", avatarSeed: "chosen", color: "#2468ac" },
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
      expect(avatar).toHaveAttribute("data-avatar-shape", "long-crown")
      expect(avatar).toHaveAttribute("data-avatar-mood", "waiting")
      expect(avatar.querySelector("[data-avatar-body]")).toHaveAttribute("fill", "#2468ac")
    }
    openRoutines()
    await screen.findByRole("region", { name: "Rotinas", exact: true })

    const cronAvatar = container.querySelector('.routine-item .tb-avatar[data-bot-id="bot-mark"]')
    expect(cronAvatar).toHaveAttribute("data-avatar-shape", "long-crown")
    expect(cronAvatar).toHaveAttribute("data-avatar-mood", "waiting")
  })

  it("previews every state, shuffles a full look and restores the seeded automatic look", () => {
    const change = vi.fn()
    vi.spyOn(Math, "random").mockReturnValue(0.99)
    const { container } = render(<AvatarPicker bot={bot} name="Clara" onChange={change} />)
    const preview = () => container.querySelector(".avatar-picker-stage .tb-avatar")

    fireEvent.click(screen.getByRole("radio", { name: "Aguardando" }))
    const hopBeforeChoice = container.querySelector(".avatar-picker-hop")
    fireEvent.click(screen.getByRole("button", { name: "Sortear" }))
    const hop = container.querySelector(".avatar-picker-hop")
    fireEvent.click(screen.getByRole("button", { name: "Restaurar automático" }))

    expect(hopBeforeChoice).toBeNull()
    expect(hop).not.toBeNull()
    expect(container.querySelector(".avatar-picker-hop")).not.toBe(hop)
    expect(preview()).toHaveAttribute("data-avatar-phase", "waiting")
    expect(screen.getByText("Precisa da sua aprovação")).toBeVisible()
    expect(screen.getByRole("radio", { name: "Acessório Coroa" })).toBeChecked()
    expect(change.mock.calls).toEqual([
      [{ color: "#e152b0", avatarShape: "none-crown" }],
      [{ color: null, avatarShape: avatarProfileFor({ id: bot.id, color: null }).shape }],
    ])
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
    fireEvent.click(screen.getByRole("radio", { name: "Chifres Longos" }))
    fireEvent.click(screen.getByRole("radio", { name: "Acessório Coroa" }))
    fireEvent.click(screen.getByRole("radio", { name: "Cor Azul" }))
    fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
    fireEvent.change(screen.getByLabelText("Função"), { target: { value: "SEO do site" } })
    fireEvent.change(screen.getByLabelText("Título (opcional)"), { target: { value: "Analista" } })
    fireEvent.change(screen.getByLabelText("Máquina"), { target: { value: "vm" } })
    fireEvent.change(screen.getByLabelText("Parar após minutos sem atividade"), { target: { value: "30" } })
    fireEvent.click(screen.getByRole("switch", { name: /Usar meu login do Codex/ }))
    fireEvent.click(screen.getByRole("button", { name: "Criar bot" }))
    await waitFor(() =>
      expect(created).toMatchObject({
        avatarShape: "long-crown",
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
    expect(screen.getByRole("radio", { name: "Chifres Longos" })).toBeChecked()
    expect(screen.getByRole("radio", { name: "Acessório Coroa" })).toBeChecked()
    expect(screen.getByRole("radio", { name: "Cor Azul" })).toBeChecked()
    expect(screen.getByLabelText("O que ele faz")).toHaveValue("SEO do site")
    fireEvent.click(screen.getByRole("radio", { name: "Chifres Curtos" }))
    fireEvent.click(screen.getByRole("button", { name: /^Avançado(?: Ajustes deste bot)?$/ }))
    expect(screen.getByLabelText("Título (opcional)")).toHaveValue("Analista")
    fireEvent.click(screen.getByRole("tab", { name: "Computador" }))
    expect(screen.getByLabelText("Máquina")).toHaveValue("vm")
    expect(screen.getByLabelText("Parar após minutos sem atividade")).toHaveValue(30)
    expect(screen.getByRole("switch", { name: /Usar meu login do Codex/ })).toBeChecked()
    fireEvent.change(screen.getByLabelText("Parar após minutos sem atividade"), { target: { value: "45" } })
    fireEvent.click(screen.getByRole("switch", { name: /Permitir controle da tela deste computador/ }))
    fireEvent.click(screen.getByRole("button", { name: "Salvar configurações" }))
    await waitFor(() =>
      expect(api.getState().bots.find((item) => item.id === saved.id)).toMatchObject({
        avatarShape: "short-crown",
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
  it("saves bot settings without rewriting a stored look the user did not change", async () => {
    const patches: Partial<Bot>[] = []
    const actions = {
      updateBot: async (_id: string, patch: Partial<Bot>) => {
        patches.push(patch)
      },
    } as WorkspaceActions
    const legacy = createMockApi().getState().bots[0]
    if (!legacy) throw new Error("Missing mock bot")
    render(
      <BotSettingsModal
        bot={{ ...legacy, avatarShape: "cercle", color: "#123456" }}
        projects={[]}
        routines={[]}
        actions={actions}
        onClose={() => undefined}
      />,
    )

    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Renamed" } })
    fireEvent.click(screen.getByRole("button", { name: "Salvar configurações" }))

    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]).toMatchObject({ name: "Renamed" })
    expect(patches[0]).not.toHaveProperty("avatarShape")
    expect(patches[0]).not.toHaveProperty("color")
  })
  it("gives each new group its own seeded look and keeps an edited group's stored shape", async () => {
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002")
    const saved: GroupInput[] = []
    const [mark] = createMockApi().getState().bots
    if (!mark) throw new Error("Missing mock bot")
    const open = (group: BotGroup | null) =>
      render(
        <GroupModal
          group={group}
          initial={{ name: "Produto", memberIds: [mark.id] }}
          bots={[mark]}
          onClose={() => undefined}
          onSave={async (input) => {
            saved.push(input)
          }}
        />,
      )
    const save = async (label: string) => {
      const count = saved.length
      fireEvent.click(screen.getByRole("button", { name: label }))
      await waitFor(() => expect(saved).toHaveLength(count + 1))
      cleanup()
    }

    open(null)
    await save("Criar grupo")
    open(null)
    await save("Criar grupo")
    const legacy = { ...saved[0], id: "g", avatarShape: "nuage", avatarSeed: "g", createdAt: 1, updatedAt: 1 }
    open(legacy as BotGroup)
    await save("Salvar grupo")

    expect(saved[0]).not.toEqual(saved[1])
    expect(saved[2]?.avatarShape).toBe("nuage")
  })
})
