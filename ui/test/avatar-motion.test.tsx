import { makeBlock, POSES, STATES } from "@norbert_bodziony/bloub"
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import {
  AVATAR_COLOR_CHOICES,
  AVATAR_COLORS,
  AVATAR_HUES,
  AVATAR_SHAPES,
  AVATAR_STATES,
  avatarCycle,
  avatarFrameMarkup,
  avatarHueColor,
  avatarPresentation,
  avatarProfileFor,
  avatarSeedHash,
  createAvatarEngine,
} from "@touri/contracts/avatar"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AvatarGaze, AvatarPlayback, attachAvatarGaze } from "../src/components/avatarMotion"
import { BotAvatar } from "../src/components/BotAvatar"

const bot = { id: "mark", color: null }
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.motion
})

describe("avatar identity specification", () => {
  it.each([
    ["mark", "capsule", "#f08a24", "fier"],
    ["onb", "galet", "#3ecf8e", "colere"],
    ["Panko", "galet", "#3ecf8e", "blase"],
    ["seo", "galet", "#3ecf8e", "blase"],
    ["qa-bot", "cercle", "#8b5cf6", "attentif"],
    ["review", "squircle", "#2fbfa0", "triste"],
  ])("matches the extracted identity for %s", (seed, shape, color, expression) => {
    expect(avatarProfileFor({ id: "other", avatarSeed: seed, color: null })).toMatchObject({ shape, color, expression })
    expect(avatarSeedHash("😀")).toBe(3409036472)
  })
  it("replaces legacy accent colors, supports all seeded expressions, and excludes the drop", () => {
    expect(avatarProfileFor({ ...bot, color: "#ff8a3d" })).toEqual(avatarProfileFor(bot))
    const profiles = Array.from({ length: 500 }, (_, i) => avatarProfileFor({ id: `fixture-${i}`, color: null }))
    expect(new Set(profiles.map((p) => p.expression)).size).toBe(16)
    expect(new Set(profiles.map((p) => p.shape)).size).toBe(7)
    expect(AVATAR_SHAPES.map((p) => p.id)).not.toContain("goutte")
    expect(avatarProfileFor({ ...bot, avatarShape: "goutte" }).shape).not.toBe("goutte")
  })
  it("maps all ten stored hues to eight colors and exposes the correct labels", () => {
    expect(AVATAR_HUES.map(({ label }) => label)).toEqual([
      "Red",
      "Orange",
      "Yellow",
      "Lime",
      "Green",
      "Cyan",
      "Blue",
      "Indigo",
      "Violet",
      "Magenta",
    ])
    expect(AVATAR_COLOR_CHOICES.map(({ hue }) => hue)).toEqual([0, 30, 55, 150, 185, 215, 245, 320])
    expect(AVATAR_COLORS).toHaveLength(8)
    expect(AVATAR_HUES.map(({ hue }) => avatarHueColor(hue))).toEqual([
      "#e8483f",
      "#f08a24",
      "#f0b429",
      "#3ecf8e",
      "#3ecf8e",
      "#2fbfa0",
      "#3b93f0",
      "#8b5cf6",
      "#8b5cf6",
      "#e152b0",
    ])
    expect(avatarProfileFor({ ...bot, avatarHue: 280 }).color).toBe("#8b5cf6")
  })
})

describe("avatar motion specification", () => {
  it("keeps the initial gaze finite at animation time zero for every shape", () => {
    for (const { id: shape } of AVATAR_SHAPES) {
      const profile = avatarProfileFor({ ...bot, avatarShape: shape })
      const frame = createAvatarEngine(profile, "idle").sample(0)
      expect(frame.eyes).toHaveLength(2)
      expect(avatarFrameMarkup(frame, profile.color)).not.toMatch(/NaN|Infinity/)
    }
  })
  it("keeps SVG transforms finite when switching bots and stops detached callbacks", () => {
    let callback: FrameRequestCallback | undefined
    const request = vi.fn((next: FrameRequestCallback) => {
      callback = next
      return 1
    })
    vi.stubGlobal("requestAnimationFrame", request)
    vi.stubGlobal("cancelAnimationFrame", vi.fn())
    const view = render(<BotAvatar bot={bot} state="thinking" animationOffset={0} />)
    for (const id of ["mark", "qa-bot", "review"]) {
      view.rerender(<BotAvatar bot={{ ...bot, id }} state="thinking" animationOffset={0} />)
      expect(view.container.querySelector("svg")?.innerHTML).not.toMatch(/NaN|Infinity/)
      act(() => callback?.(0))
      expect(view.container.querySelector("svg")?.innerHTML).not.toMatch(/NaN|Infinity/)
    }
    view.unmount()
    request.mockClear()
    act(() => callback?.(40))
    expect(request).not.toHaveBeenCalled()
  })
  it("r3: a responded bot starts a deterministic wink/wide cycle on every hover", () => {
    let callback: FrameRequestCallback | undefined
    vi.stubGlobal("requestAnimationFrame", (next: FrameRequestCallback) => {
      callback = next
      return 1
    })
    vi.stubGlobal("cancelAnimationFrame", () => {
      callback = undefined
    })
    const view = render(<BotAvatar bot={bot} mood="responded" />)
    const element = view.container.querySelector<HTMLElement>(".tb-avatar")
    if (!element) throw new Error("avatar missing")
    fireEvent.pointerEnter(element)
    expect(element.dataset.avatarState).toBe("wink")
    const states = new Set<string>()
    for (let now = 0; now < 20_000; now += 16) {
      callback?.(now)
      states.add(element.dataset.avatarState ?? "")
    }
    expect(states.has("wide")).toBe(true)
    fireEvent.pointerLeave(element)
    fireEvent.pointerEnter(element)
    expect(element.dataset.avatarState).toBe("wink")
    vi.unstubAllGlobals()
  })
  it("presents every mood without replacing identity or adding a waiting badge", () => {
    expect([...AVATAR_STATES].sort()).toEqual(
      STATES.filter((s) => s.baseBody)
        .map((s) => s.id)
        .sort(),
    )
    const expected = [
      ["idle", "idle", null, false],
      ["working", "idle", "attentif", true],
      ["waiting", "idle", "curieux", false],
      ["failed", "idle", "triste", false],
      ["responded", "idle", "heureux", false],
      ["connecting", "swirl", "attentif", true],
      ["asleep", "idle", "somnolent", false],
    ] as const
    for (const [mood, state, expression, outline] of expected) {
      expect(avatarPresentation(mood)).toEqual({ state, expression, outline })
      const profile = avatarProfileFor({ ...bot, avatarShape: "triangle" })
      const frame = createAvatarEngine(profile, mood).sample(POSES[state])
      expect(frame.notif).toBeNull()
      expect(frame.bodyPath).not.toEqual(
        createAvatarEngine({ ...profile, shape: "cercle" }, mood).sample(POSES[state]).bodyPath,
      )
    }
  })
  it("caps draws at 30fps, clamps long frames, and resumes without advancing hidden time", () => {
    const player = new AvatarPlayback(avatarProfileFor(bot), "idle")
    let draws = 0
    for (let t = 0; t < 1000; t += 8) if (player.advance(t)) draws++
    expect(draws).toBeLessThanOrEqual(31)
    expect(draws).toBeGreaterThan(20)
    const before = player.time
    player.advance(10000)
    expect(player.time - before).toBeCloseTo(0.064)
    const paused = player.time
    player.resume()
    player.advance(100000)
    expect(player.time).toBe(paused)
  })
  it("plays idle/wink/idle/wide/idle with extended holds and a reproducible phase", () => {
    expect(avatarCycle("idle")).toEqual([
      { state: "idle", duration: 3 },
      makeBlock("wink"),
      { state: "idle", duration: 3 },
      makeBlock("wide"),
      { state: "idle", duration: 3 },
    ])
    expect(avatarCycle("connecting")).toEqual([{ state: "swirl", duration: 1.625 }])
    expect(avatarCycle("idle", -1).map((b) => b.state)).toEqual(["idle", "idle", "wink", "idle", "wide"])
    const player = new AvatarPlayback(avatarProfileFor(bot), "idle", 0, 0)
    const seen = new Set<string>()
    for (let i = 0; i < 850; i++) if (player.advance(i * 16)) seen.add(player.engine.state)
    expect([...seen]).toEqual(["idle", "wink", "wide"])
  })
  it("bounds pointer gaze around each avatar and performs two damped nods", () => {
    const gaze = new AvatarGaze()
    const box = { left: 100, top: 100, width: 40, height: 40 }
    for (let i = 0; i < 300; i++) {
      const aim = gaze.sample(i / 60, { x: 5000, y: 5000 }, box)
      expect(aim.yaw).toBeGreaterThanOrEqual(-24)
      expect(aim.yaw).toBeLessThanOrEqual(24)
      expect(aim.pitch).toBeGreaterThanOrEqual(-6)
      expect(aim.pitch).toBeLessThanOrEqual(26)
      expect(aim.mix + aim.wander).toBeCloseTo(1)
    }
    expect(gaze.sample(5, { x: 5000, y: 5000 }, box).yaw).toBeCloseTo(24)
    gaze.press()
    const base = gaze.sample(5.01, { x: 5000, y: 5000 }, box).pitch
    expect(gaze.sample(5.01 + 0.55 / 8, { x: 5000, y: 5000 }, box).pitch).toBeLessThan(base)
    expect(gaze.sample(5.01 + (3 * 0.55) / 8, { x: 5000, y: 5000 }, box).pitch).toBeGreaterThan(base)
    expect(gaze.sample(5.01 + (5 * 0.55) / 8, { x: 5000, y: 5000 }, box).pitch).toBeLessThan(base)
    expect(gaze.sample(5.01 + (7 * 0.55) / 8, { x: 5000, y: 5000 }, box).pitch).toBeGreaterThan(base)
    expect(gaze.sample(5.6, { x: 5000, y: 5000 }, box).pitch).toBeCloseTo(base)
    expect(gaze.sample(5.7, null, box).mix).toBeLessThan(1)
  })
  it("shares pointer listeners, ignores touch movement, and releases subscriptions", () => {
    const add = vi.spyOn(window, "addEventListener")
    const remove = vi.spyOn(window, "removeEventListener")
    const one = document.createElement("span"),
      two = document.createElement("span")
    vi.spyOn(one, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 32, height: 32 } as DOMRect)
    const a = attachAvatarGaze(one, new AvatarGaze()),
      b = attachAvatarGaze(two, new AvatarGaze())
    expect(add.mock.calls.filter(([type]) => type === "pointermove")).toHaveLength(1)
    const event = new Event("pointermove")
    Object.assign(event, { pointerType: "touch", clientX: 1000, clientY: 1000 })
    window.dispatchEvent(event)
    expect(a.sample(0.1).mix).toBe(0)
    a.release()
    expect(remove.mock.calls.filter(([type]) => type === "pointermove")).toHaveLength(0)
    b.release()
    expect(remove.mock.calls.filter(([type]) => type === "pointermove")).toHaveLength(1)
  })
  it("releases pointer gaze for zero-size, invalid or detached bounds and recovers", () => {
    const element = document.createElement("span")
    document.body.append(element)
    const box = { left: 0, top: 0, width: 32, height: 32 }
    const bounds = vi.spyOn(element, "getBoundingClientRect").mockReturnValue(box as DOMRect)
    const tracker = attachAvatarGaze(element, new AvatarGaze())
    const move = (x: number): void => {
      const event = new Event("pointermove")
      Object.assign(event, { pointerType: "mouse", clientX: x, clientY: 100 })
      window.dispatchEvent(event)
    }
    try {
      move(100)
      let time = 0.1
      let look = tracker.sample(time)
      expect(look.mix).toBeGreaterThan(0)
      for (const invalid of [{ width: 0 }, { height: 0 }, { left: NaN }, { top: Infinity }, { height: NaN }]) {
        bounds.mockReturnValue({ ...box, ...invalid } as DOMRect)
        time += 0.1
        const next = tracker.sample(time)
        expect(Object.values(next).every(Number.isFinite)).toBe(true)
        expect(next.mix).toBeLessThan(look.mix)
        look = next
      }
      bounds.mockReturnValue(box as DOMRect)
      move(NaN)
      time += 0.1
      const invalidPointer = tracker.sample(time)
      expect(Object.values(invalidPointer).every(Number.isFinite)).toBe(true)
      expect(invalidPointer.mix).toBeLessThan(look.mix)
      move(100)
      time += 0.1
      const recovered = tracker.sample(time)
      expect(recovered.mix).toBeGreaterThan(invalidPointer.mix)
      element.remove()
      expect(tracker.sample(time + 0.1).mix).toBeLessThan(recovered.mix)
    } finally {
      tracker.release()
      element.remove()
    }
  })
  it("rests until its control is hovered/focused and freezes when reduced motion changes", () => {
    let change: () => void = () => undefined
    const media = {
      matches: false,
      addEventListener: (_type: string, handler: () => void) => {
        change = handler
      },
      removeEventListener: () => undefined,
    }
    vi.spyOn(window, "matchMedia").mockReturnValue(media as unknown as MediaQueryList)
    const { container } = render(
      <button type="button">
        <BotAvatar bot={bot} />
      </button>,
    )
    const avatar = container.querySelector(".tb-avatar")
    const button = container.querySelector("button")
    if (!button) throw new Error("Missing control")
    expect(avatar).toHaveAttribute("data-avatar-animated", "false")
    fireEvent.pointerEnter(button)
    expect(avatar).toHaveAttribute("data-avatar-animated", "true")
    fireEvent.pointerLeave(button)
    expect(avatar).toHaveAttribute("data-avatar-animated", "false")
    fireEvent.focusIn(button)
    expect(avatar).toHaveAttribute("data-avatar-animated", "true")
    act(() => {
      media.matches = true
      change()
    })
    expect(avatar).toHaveAttribute("data-avatar-animated", "false")
    expect(avatar).toHaveAttribute("data-avatar-state", "idle")
  })
  it("retains photo identity during work and falls back to the seeded avatar on failure", () => {
    const { container, rerender } = render(<BotAvatar bot={bot} url="/photo-a.png" mood="working" />)
    expect(container.querySelector(".tb-avatar")).toHaveAttribute("data-avatar", "image")
    expect(container.querySelectorAll(".tb-avatar-rings")).toHaveLength(0)
    expect(container.querySelector(".tb-avatar-outline circle")).toBeInTheDocument()
    const image = container.querySelector("img")
    if (!image) throw new Error("Missing image")
    fireEvent.error(image)
    expect(container.querySelector(".tb-avatar")).toHaveAttribute("data-avatar", "generated")
    expect(container.querySelector("[data-avatar-body]")).toHaveAttribute("fill", "#f08a24")
    rerender(<BotAvatar bot={bot} url="/photo-b.png" mood="working" />)
    expect(container.querySelector("img")).toHaveAttribute("src", "/photo-b.png")
  })
  it("stops a running avatar when the host reduces motion and resumes when restored", async () => {
    const request = vi.fn(() => 1)
    const cancel = vi.fn()
    vi.stubGlobal("requestAnimationFrame", request)
    vi.stubGlobal("cancelAnimationFrame", cancel)
    vi.spyOn(document, "hidden", "get").mockReturnValue(false)
    const view = render(<BotAvatar bot={bot} state="thinking" motion="always" followPointer />)
    const avatar = view.container.querySelector(".tb-avatar")
    expect(avatar).toHaveAttribute("data-avatar-animated", "true")
    expect(request).toHaveBeenCalled()
    document.documentElement.dataset.motion = "reduce"
    await waitFor(() => expect(avatar).toHaveAttribute("data-avatar-animated", "false"))
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(1))
    expect(avatar).toHaveAttribute("data-mascot-phase", "thinking")
    delete document.documentElement.dataset.motion
    await waitFor(() => expect(avatar).toHaveAttribute("data-avatar-animated", "true"))
  })
})
