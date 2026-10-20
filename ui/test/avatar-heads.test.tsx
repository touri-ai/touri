import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { AvatarLegacyShape, AvatarShape } from "@touri/contracts"
import {
  AVATAR_ACCESSORIES,
  AVATAR_HORNS,
  type AvatarIdentity,
  type AvatarMood,
  type AvatarPath,
  type AvatarPhase,
  avatarBullFor,
  avatarProfileFor,
  avatarShapeFor,
  LEGACY_AVATAR_SHAPES,
  renderAvatarSvg,
  validAvatarShape,
} from "@touri/contracts/avatar"
import { useState } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { AvatarPicker } from "../src/components/AvatarPicker"
import { BotAvatar } from "../src/components/BotAvatar"

const PHASES: readonly AvatarPhase[] = ["idle", "thinking", "working", "waiting", "done", "failed", "asleep"]
const MOODS: readonly AvatarMood[] = ["idle", "connecting", "working", "waiting", "responded", "failed", "asleep"]
const HEADS: readonly { shape: AvatarLegacyShape; start: string; eyeX: number; eyeY: number; snoutY: number }[] = [
  { shape: "cercle", start: "M50 30", eyeX: 33.85, eyeY: 55.5, snoutY: 78 },
  { shape: "galet", start: "M50 31", eyeX: 31, eyeY: 56, snoutY: 79.5 },
  { shape: "squircle", start: "M34 31", eyeX: 33.28, eyeY: 55.5, snoutY: 79 },
  { shape: "capsule", start: "M50 28", eyeX: 36.7, eyeY: 54, snoutY: 79 },
  { shape: "triangle", start: "M20 31", eyeX: 34.8, eyeY: 51, snoutY: 71 },
  { shape: "hexagone", start: "M47 28", eyeX: 32.9, eyeY: 58, snoutY: 80 },
  { shape: "nuage", start: "M50 32", eyeX: 31.76, eyeY: 56.5, snoutY: 78.5 },
]

afterEach(cleanup)

describe("bull head identity", () => {
  it("draws seven different actual head paths for the seven stored silhouettes", () => {
    const bots = LEGACY_AVATAR_SHAPES.map((shape) => getBot(shape))

    const heads = bots.map((bot) => avatarBullFor(avatarProfileFor(bot), "idle").head)

    expect(new Set(heads).size).toBe(7)
  })

  it("derives diverse head geometry from the seed, independent of the bot id and chosen look", () => {
    const seeds = Array.from({ length: 128 }, (_, index) => `shape-seed-${index}`)

    const profiles = seeds.map((avatarSeed) => avatarProfileFor({ id: "first", avatarSeed, color: null }))
    const renamed = seeds.map((avatarSeed) => avatarProfileFor({ id: "second", avatarSeed, color: null }))
    const customized = seeds.map((avatarSeed) =>
      avatarProfileFor({ id: "second", avatarSeed, avatarShape: "none-glasses", color: "#123456" }),
    )
    const fromIds = seeds.map((id) => avatarProfileFor({ id, color: null }))
    const paths = profiles.map((profile) => avatarBullFor(profile, "idle").head)

    expect(renamed).toEqual(profiles)
    expect(fromIds).toEqual(profiles)
    expect(customized.map((profile) => profile.headShape)).toEqual(profiles.map((profile) => profile.headShape))
    expect(new Set(paths).size).toBe(7)
    expect(new Set(profiles.map((profile) => profile.headShape))).toEqual(new Set(LEGACY_AVATAR_SHAPES))
  })

  it.each(HEADS)("maps $shape to its own geometry and keeps the seeded look", ({ shape, start }) => {
    const bot = getBot(shape)
    const automatic = avatarProfileFor({ id: bot.id, avatarSeed: bot.avatarSeed, color: bot.color })

    const profile = avatarProfileFor(bot)
    const bull = avatarBullFor(profile, "idle")

    expect(profile.headShape).toBe(shape)
    expect(bull.head.startsWith(start)).toBe(true)
    expect(profile.shape).toBe(automatic.shape)
    expect(profile.horns).toBe(automatic.horns)
    expect(profile.accessory).toBe(automatic.accessory)
    expect(profile.color).toBe(automatic.color)
    expect(profile.offset).toBe(automatic.offset)
    expect(avatarShapeFor(bot)).toBe(shape)
  })

  it.each(LEGACY_AVATAR_SHAPES)("holds the %s head through every phase, horn and accessory", (headShape) => {
    const looks = AVATAR_HORNS.flatMap((horns) =>
      AVATAR_ACCESSORIES.map((accessory) => ({ headShape, horns, accessory, color: "#e8483f" })),
    )

    const heads = looks.flatMap((look) => PHASES.map((phase) => avatarBullFor(look, phase).head))

    expect(new Set(heads).size).toBe(1)
  })

  it("accepts bounded explicit head/look combinations and rejects malformed variants", () => {
    const shapes = LEGACY_AVATAR_SHAPES.flatMap((head) =>
      AVATAR_HORNS.flatMap((horns) => AVATAR_ACCESSORIES.map((accessory) => `${head}:${horns}-${accessory}`)),
    )
    const invalid = ["goutte:short-cap", "nuage:short-unknown", "cercle:short-cap:extra", "__proto__:short-cap"]

    const accepted = shapes.map(validAvatarShape)
    const rejected = invalid.map(validAvatarShape)

    expect(accepted.every(Boolean)).toBe(true)
    expect(rejected).toEqual([false, false, false, false])
  })
})

describe("head registrations", () => {
  it.each(HEADS)("places the eyes, snout and attached effects on $shape in every phase", (head) => {
    const look = { headShape: head.shape, color: "#e8483f", horns: "classic", accessory: "none" } as const

    const bulls = PHASES.map((phase) => avatarBullFor(look, phase))

    bulls.forEach((bull) => {
      const snout = bull.body.find((path) => path.fill === "#ffc94d")

      expect(getPlacedPoint(bull.eyes[0], 31, 56)).toEqual({ x: head.eyeX, y: head.eyeY })
      expect(getPlacedPoint(snout, 50, 79.5)).toEqual({ x: 50, y: head.snoutY })
      expect(bull.silhouette).toContain(bull.head)
      expect(bull.body.filter((path) => path.d === bull.head && !path.stroke)).toHaveLength(1)
    })
    const steam = bulls[2]?.effects.find((effect) => effect.id === "steam-left")?.paths[0]
    const tear = bulls[5]?.effects.find((effect) => effect.id === "tear")?.paths[0]
    expect(getPlacedPoint(steam, 50, 79.5)).toEqual({ x: 50, y: head.snoutY })
    expect(getPlacedPoint(tear, 31, 56)).toEqual({ x: head.eyeX, y: head.eyeY })
  })

  it("registers actual ears and horn roots independently for each silhouette", () => {
    const looks = LEGACY_AVATAR_SHAPES.map((headShape) =>
      avatarBullFor({ headShape, color: "#e8483f", horns: "classic", accessory: "none" }, "idle"),
    )

    const horns = looks.map((bull) => bull.silhouette[0])
    const ears = looks.map((bull) => bull.silhouette[2])

    expect(new Set(horns).size).toBe(7)
    expect(new Set(ears).size).toBe(7)
    expect(horns).toContain("M22 40C16 33 12 24 11 13C11 9.5 14.5 8.5 16 11.5C19 21 25 28 35 33Z")
    expect(ears).toContain("M17 45C10 42 3 44 1 49C3 56 10 59 17 58Z")
  })

  it.each(AVATAR_ACCESSORIES.filter((accessory) => accessory !== "none"))(
    "places %s on a different registration for every head without changing it between phases",
    (accessory) => {
      const registrations = LEGACY_AVATAR_SHAPES.map((headShape) =>
        PHASES.map(
          (phase) => avatarBullFor({ headShape, color: "#e8483f", horns: "classic", accessory }, phase).accessory,
        ),
      )

      const transforms = registrations.map((phases) => phases[0]?.[0]?.transform)

      expect(new Set(transforms).size).toBe(7)
      registrations.forEach((phases) => {
        expect(phases.every((paths) => paths[0]?.transform === phases[0]?.[0]?.transform)).toBe(true)
      })
    },
  )
})

describe("React and portable SVG parity", () => {
  it.each(LEGACY_AVATAR_SHAPES)("renders identical placed paths for %s in every mood and accessory", (shape) => {
    const variants = MOODS.flatMap((mood) => AVATAR_ACCESSORIES.map((accessory) => ({ mood, accessory })))
    const { container, rerender } = render(<BotAvatar bot={getBot(shape)} still />)

    variants.forEach(({ mood, accessory }) => {
      const bot = getBot(`${shape}:long-${accessory}`)
      const svg = new DOMParser().parseFromString(renderAvatarSvg(bot, { mood, size: 64 }), "image/svg+xml")

      rerender(<BotAvatar bot={bot} mood={mood} size={64} still />)

      expect(getPaths(container)).toEqual(getPaths(svg))
      expect(container.querySelector("[data-avatar-body]")?.getAttribute("d")).toBe(
        avatarBullFor(avatarProfileFor(bot), "idle").head,
      )
    })
  })

  it("updates the React head when only the stored silhouette changes", () => {
    const first = getBot("cercle:classic-none")
    const next = getBot("nuage:classic-none")
    const svg = new DOMParser().parseFromString(renderAvatarSvg(next), "image/svg+xml")
    const { container, rerender } = render(<BotAvatar bot={first} still />)
    const original = container.querySelector("[data-avatar-body]")?.getAttribute("d")

    rerender(<BotAvatar bot={next} still />)

    expect(getPaths(container)).toEqual(getPaths(svg))
    expect(container.querySelector("[data-avatar-body]")?.getAttribute("d")).not.toBe(original)
  })
})

describe("picker head preservation", () => {
  it.each(LEGACY_AVATAR_SHAPES)("keeps %s through mood, colour, horns, accessories, reset and reopening", (shape) => {
    const { container, unmount } = render(<Picker bot={getBot(shape)} />)
    const head = container.querySelector(".avatar-picker-stage [data-avatar-body]")?.getAttribute("d")

    fireEvent.click(screen.getByRole("radio", { name: "Chifres Longos", exact: true }))
    fireEvent.click(screen.getByRole("radio", { name: "Acessório Óculos", exact: true }))
    fireEvent.click(screen.getByRole("radio", { name: "Cor Azul", exact: true }))
    fireEvent.click(screen.getByRole("radio", { name: "Trabalhando", exact: true }))
    const saved = getBot(`${shape}:long-glasses`, "#3b93f0")

    expect(container.querySelector(".avatar-picker-stage [data-avatar-body]")).toHaveAttribute("d", head)
    expect(container.querySelector("output")?.textContent).toBe(saved.avatarShape)
    expect(screen.getByRole("radio", { name: "Chifres Longos", exact: true })).toBeChecked()
    expect(screen.getByRole("radio", { name: "Acessório Óculos", exact: true })).toBeChecked()
    const thumbnails = Array.from(container.querySelectorAll(".avatar-options [data-avatar-body]"), (path) =>
      path.getAttribute("d"),
    )
    expect(thumbnails).toEqual(Array.from({ length: 11 }, () => head))
    unmount()

    const reopened = render(<Picker bot={saved} />)

    expect(reopened.container.querySelector(".avatar-picker-stage [data-avatar-body]")).toHaveAttribute("d", head)
    fireEvent.click(screen.getByRole("button", { name: "Sortear", exact: true }))
    expect(reopened.container.querySelector(".avatar-picker-stage [data-avatar-body]")).toHaveAttribute("d", head)
    fireEvent.click(screen.getByRole("button", { name: "Restaurar automático", exact: true }))
    expect(reopened.container.querySelector("output")?.textContent).toBe(shape)
    expect(reopened.container.querySelector(".avatar-picker-stage [data-avatar-body]")).toHaveAttribute("d", head)
    expect(screen.getByRole("radio", { name: "Cor Automática", exact: true })).toBeChecked()
  })

  it("keeps a seeded head through look edits, shuffle and restoring automatic", () => {
    const { container } = render(<Picker bot={getBot("long-crown")} />)
    const head = container.querySelector(".avatar-picker-stage [data-avatar-body]")?.getAttribute("d")

    fireEvent.click(screen.getByRole("radio", { name: "Chifres Curtos", exact: true }))
    fireEvent.click(screen.getByRole("radio", { name: "Acessório Óculos", exact: true }))

    expect(container.querySelector("output")?.textContent).toBe("short-glasses")
    expect(container.querySelector(".avatar-picker-stage [data-avatar-body]")).toHaveAttribute("d", head)

    fireEvent.click(screen.getByRole("button", { name: "Sortear", exact: true }))

    expect(container.querySelector(".avatar-picker-stage [data-avatar-body]")).toHaveAttribute("d", head)

    fireEvent.click(screen.getByRole("button", { name: "Restaurar automático", exact: true }))

    expect(container.querySelector(".avatar-picker-stage [data-avatar-body]")).toHaveAttribute("d", head)
    expect(screen.getByRole("radio", { name: "Cor Automática", exact: true })).toBeChecked()
  })
})

const getBot = (avatarShape: AvatarShape, color = "#e8483f"): AvatarIdentity => ({
  id: "shape-fixture",
  avatarSeed: "fixed-shape-seed",
  avatarShape,
  color,
})

const getPlacedPoint = (path: AvatarPath | undefined, x: number, y: number) => {
  const values = path?.transform?.match(/-?[\d.]+/g)?.map(Number)
  if (values?.length !== 6) throw new Error("Missing feature placement")
  const [scaleX = 1, , , scaleY = 1, offsetX = 0, offsetY = 0] = values

  return { x: Number((x * scaleX + offsetX).toFixed(3)), y: Number((y * scaleY + offsetY).toFixed(3)) }
}

const getPaths = (root: ParentNode) =>
  Array.from(root.querySelectorAll("path"), (path) => ({
    d: path.getAttribute("d"),
    fill: path.getAttribute("fill"),
    stroke: path.getAttribute("stroke"),
    width: path.getAttribute("stroke-width"),
    transform: path.getAttribute("transform"),
  }))

const Picker = ({ bot }: { bot: AvatarIdentity }) => {
  const [draft, setDraft] = useState(bot)

  return (
    <>
      <AvatarPicker
        bot={draft}
        onChange={(choice) =>
          setDraft((current) => ({
            id: current.id,
            avatarSeed: current.avatarSeed,
            avatarShape: choice.avatarShape ?? current.avatarShape,
            color: choice.color === undefined ? current.color : choice.color,
          }))
        }
      />
      <output>{draft.avatarShape}</output>
    </>
  )
}
