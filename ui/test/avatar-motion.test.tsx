import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import {
  AVATAR_ACCESSORIES,
  AVATAR_COLOR_CHOICES,
  AVATAR_COLORS,
  AVATAR_HORNS,
  AVATAR_HUES,
  AVATAR_SHAPES,
  type AvatarPhase,
  avatarBullFor,
  avatarHueColor,
  avatarProfileFor,
  avatarSeedHash,
  LEGACY_AVATAR_SHAPES,
  validAvatarShape,
} from "@touri/contracts/avatar"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BotAvatar } from "../src/components/BotAvatar"

const bot = { id: "mark", color: null }
const look = { color: "#e8483f", horns: "classic", accessory: "none" } as const
const PHASES: AvatarPhase[] = ["idle", "thinking", "working", "waiting", "done", "failed", "asleep"]
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  delete document.documentElement.dataset.motion
})

describe("avatar identity specification", () => {
  it.each([
    ["mark", "classic-none", "#f08a24"],
    ["onb", "long-crown", "#3ecf8e"],
    ["Panko", "long-flower", "#3ecf8e"],
    ["seo", "long-headphones", "#3ecf8e"],
    ["qa-bot", "none-glasses", "#8b5cf6"],
    ["review", "short-cap", "#2fbfa0"],
  ])("derives a stable automatic look for %s", (seed, shape, color) => {
    expect(avatarProfileFor({ id: "other", avatarSeed: seed, color: null })).toMatchObject({ shape, color })
    expect(avatarSeedHash("😀")).toBe(3409036472)
  })
  it("replaces legacy accent colors and silhouettes, and reaches every horn and accessory", () => {
    const profiles = Array.from({ length: 500 }, (_, i) => avatarProfileFor({ id: `fixture-${i}`, color: null }))

    expect(avatarProfileFor({ ...bot, color: "#ff8a3d" })).toEqual(avatarProfileFor(bot))
    expect(avatarProfileFor({ ...bot, avatarShape: "goutte" as never })).toEqual(avatarProfileFor(bot))
    expect(avatarProfileFor({ ...bot, avatarShape: "long-crown" })).toMatchObject({ horns: "long", accessory: "crown" })
    expect(new Set(profiles.map((profile) => profile.shape)).size).toBe(AVATAR_SHAPES.length)
    expect(AVATAR_SHAPES).toHaveLength(AVATAR_HORNS.length * AVATAR_ACCESSORIES.length)
  })
  it("keeps accepting the stored silhouette ids and renders them as the seeded look", () => {
    expect(LEGACY_AVATAR_SHAPES.every(validAvatarShape)).toBe(true)
    expect(validAvatarShape("goutte")).toBe(false)
    expect(avatarProfileFor({ ...bot, avatarShape: "cercle" })).toEqual(avatarProfileFor(bot))
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

describe("vector bull specification", () => {
  it("draws the pixel bull's parts in vector: ink outline under horns, ears and head, then fills and light eyes", () => {
    const bull = avatarBullFor(look, "idle")
    const ink = bull.body.slice(0, bull.silhouette.length)
    const head = bull.body.find((path) => path.d === bull.head && !path.stroke)

    expect(ink.map((path) => path.d)).toEqual(bull.silhouette)
    expect(new Set(ink.map((path) => path.fill)).size).toBe(1)
    expect(head?.fill).toBe(look.color)
    expect(bull.body.map((path) => path.fill)).toContain("#ffc94d")
    expect(bull.eyes.every((eye) => (eye.stroke ?? eye.fill) === "#ffffff")).toBe(true)
    expect(JSON.stringify(bull)).not.toMatch(/crispEdges|NaN|undefined/)
  })
  it("mirrors horns and ears, and draws every accessory except none", () => {
    const xs = (d: string) => [...d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map(([, x]) => Number(x))
    const [left, right] = avatarBullFor(look, "idle").silhouette

    expect(xs(right ?? "")).toEqual(xs(left ?? "").map((x) => +(100 - x).toFixed(2)))
    expect(avatarBullFor({ ...look, horns: "none" }, "idle").silhouette).toHaveLength(3)
    expect(avatarBullFor(look, "idle").accessory).toEqual([])
    for (const accessory of AVATAR_ACCESSORIES.filter((item) => item !== "none"))
      expect(avatarBullFor({ ...look, accessory }, "idle").accessory.length).toBeGreaterThan(0)
  })
  it("gives each phase its own eyes and effect, glows while thinking or working, and blinks only while calm", () => {
    const bulls = PHASES.map((phase) => avatarBullFor(look, phase))

    expect(new Set(bulls.map((bull) => JSON.stringify(bull.eyes))).size).toBe(PHASES.length)
    expect(new Set(bulls.map((bull) => JSON.stringify(bull.body))).size).toBe(PHASES.length)
    expect(bulls.map((bull) => bull.aura)).toEqual([false, true, true, false, false, false, false])
    expect(bulls.map((bull) => bull.blink)).toEqual([true, true, true, true, false, false, false])
    expect(bulls.map((bull) => bull.effects.map((effect) => effect.id))).toEqual([
      [],
      ["dot-1", "dot-2", "dot-3"],
      ["steam-left", "steam-right"],
      ["alert"],
      ["sparkle-1", "sparkle-2"],
      ["smoke", "tear"],
      ["snore-1", "snore-2"],
    ])
  })
  it("shades ears and outline from the bot colour, pales the yellow bull's snout and falls back on invalid input", () => {
    const blue = avatarBullFor({ ...look, color: "#3b93f0" }, "idle")

    expect(blue.body.map((path) => path.fill)).toContain("#89bef6")
    expect(avatarBullFor({ ...look, color: "#f0b429" }, "idle").body.map((path) => path.fill)).toContain("#ffe2b8")
    expect(avatarBullFor({ ...look, color: "url(#x)" }, "idle")).toEqual(avatarBullFor(look, "idle"))
  })
})

describe("avatar motion specification", () => {
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
  })
  it("animates every non-idle phase with CSS only, never a frame loop", () => {
    const frame = vi.spyOn(window, "requestAnimationFrame")
    const { container, rerender } = render(<BotAvatar bot={bot} state="thinking" />)
    const avatar = container.querySelector(".tb-avatar")

    expect(avatar).toHaveAttribute("data-avatar-phase", "thinking")
    expect(avatar).toHaveAttribute("data-avatar-animated", "true")
    expect(container.querySelectorAll(".tb-avatar-fx")).toHaveLength(3)
    rerender(<BotAvatar bot={bot} state="thinking" still />)
    expect(avatar).toHaveAttribute("data-avatar-animated", "false")
    expect(container.querySelectorAll(".tb-avatar-fx")).toHaveLength(3)
    rerender(<BotAvatar bot={bot} state="thinking" size={18} />)
    expect(container.querySelectorAll(".tb-avatar-fx")).toHaveLength(0)
    expect(frame).not.toHaveBeenCalled()
  })
  it("holds sleeping and parked bots still, while the customizer still previews the asleep motion", () => {
    const { container, rerender } = render(<BotAvatar bot={bot} state="sleeping" motion="always" />)
    const avatar = container.querySelector(".tb-avatar")

    expect(avatar).toHaveAttribute("data-avatar-phase", "asleep")
    expect(avatar).toHaveAttribute("data-avatar-animated", "false")
    rerender(<BotAvatar bot={bot} state="parked" motion="always" />)
    expect(avatar).toHaveAttribute("data-avatar-animated", "false")
    rerender(<BotAvatar bot={bot} mood="asleep" motion="always" />)
    expect(avatar).toHaveAttribute("data-avatar-animated", "true")
  })
  it("turns the eyes toward the pointer once per frame and lets go on unmount", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((paint) => {
      paint(0)
      return 1
    })
    const { container, unmount } = render(<BotAvatar bot={bot} followPointer />)
    const avatar = container.querySelector<HTMLElement>(".tb-avatar")
    if (!avatar) throw new Error("Missing avatar")

    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 500, clientY: 0 }))
    })

    expect(avatar.style.getPropertyValue("--avatar-gaze-x")).toBe("4.00px")
    expect(avatar.style.getPropertyValue("--avatar-gaze-y")).toBe("0.00px")
    unmount()
    expect(avatar.style.getPropertyValue("--avatar-gaze-x")).toBe("")
  })
  it("retains photo identity during work and falls back to the seeded avatar on failure", () => {
    const { container, rerender } = render(<BotAvatar bot={bot} url="/photo-a.png" mood="working" />)
    const image = container.querySelector("img")
    if (!image) throw new Error("Missing image")

    expect(container.querySelector(".tb-avatar")).toHaveAttribute("data-avatar", "image")
    expect(container.querySelector(".tb-avatar-outline circle")).toBeInTheDocument()
    fireEvent.error(image)
    expect(container.querySelector(".tb-avatar-aura")).toBeInTheDocument()
    expect(container.querySelector(".tb-avatar")).toHaveAttribute("data-avatar", "generated")
    expect(container.querySelector("[data-avatar-body]")).toHaveAttribute("fill", "#f08a24")
    rerender(<BotAvatar bot={bot} url="/photo-b.png" mood="working" />)
    expect(container.querySelector("img")).toHaveAttribute("src", "/photo-b.png")
  })
  it("stops a running avatar when the host reduces motion and resumes when restored", async () => {
    const view = render(<BotAvatar bot={bot} state="thinking" motion="always" />)
    const avatar = view.container.querySelector(".tb-avatar")

    expect(avatar).toHaveAttribute("data-avatar-animated", "true")
    document.documentElement.dataset.motion = "reduce"
    await waitFor(() => expect(avatar).toHaveAttribute("data-avatar-animated", "false"))
    expect(avatar).toHaveAttribute("data-mascot-phase", "thinking")
    delete document.documentElement.dataset.motion
    await waitFor(() => expect(avatar).toHaveAttribute("data-avatar-animated", "true"))
  })
})
