import {
  type Block,
  BotEngine,
  type BotFrame,
  COLOR_BY_ID,
  COLORS,
  type ColorId,
  DEMI_VIEWBOX,
  EXPRESSION_BY_ID,
  EXPRESSIONS,
  type ExpressionId,
  makeBlock,
  POSES,
  RAYON,
  SHAPE_BY_ID,
  SHAPES,
  STATE_BY_ID,
  type StateId,
} from "@norbert_bodziony/bloub"
import type { AvatarShape, Bot, Message, NotificationRecord, Run } from "./types"

export type AvatarHue = 0 | 30 | 55 | 100 | 150 | 185 | 215 | 245 | 280 | 320
export type AvatarIdentity = Pick<Bot, "id" | "color"> &
  Pick<Partial<Bot>, "avatarShape" | "avatarSeed" | "avatarPath"> & { avatarHue?: AvatarHue | null }
export type AvatarMood = "idle" | "working" | "waiting" | "failed" | "responded" | "asleep" | "connecting"
export type AvatarMotion = "hover" | "idle" | "always"
export type AvatarFrame = BotFrame
export type AvatarProfile = { shape: AvatarShape; color: string; expression: ExpressionId; phase: number }
export type AvatarPresentation = { state: StateId; expression: ExpressionId | null; outline: boolean }

export const AVATAR_FPS = 30
export const AVATAR_SHAPES = SHAPES.filter((shape) => shape.id !== "goutte")
export const AVATAR_COLORS: readonly ColorId[] = [
  "rouge",
  "orange",
  "ambre",
  "vert",
  "turquoise",
  "bleu",
  "violet",
  "rose",
]
const hueEntries = [
  [0, "Red", "rouge"],
  [30, "Orange", "orange"],
  [55, "Yellow", "ambre"],
  [100, "Lime", "vert"],
  [150, "Green", "vert"],
  [185, "Cyan", "turquoise"],
  [215, "Blue", "bleu"],
  [245, "Indigo", "violet"],
  [280, "Violet", "violet"],
  [320, "Magenta", "rose"],
] as const
export const AVATAR_HUES = hueEntries.map(([hue, label, color]) => ({
  hue,
  label,
  color,
  hex: COLOR_BY_ID.get(color)?.hex ?? "#0a0a0c",
}))
export const AVATAR_COLOR_CHOICES = AVATAR_HUES.filter(({ hue }) => hue !== 100 && hue !== 280)
export const avatarHueColor = (hue: AvatarHue): string =>
  AVATAR_HUES.find((option) => option.hue === hue)?.hex ?? "#0a0a0c"

// FNV-1a over UTF-16 code units makes persisted identities reproducible in JS and native exports.
export const avatarSeedHash = (seed: string): number => {
  let result = 2166136261
  for (let i = 0; i < seed.length; i++) result = Math.imul(result ^ seed.charCodeAt(i), 16777619)
  return result >>> 0
}
const seededIndex = (seed: string, field: string, count: number): number => avatarSeedHash(`${seed}:${field}`) % count
export const validAvatarShape = (shape: unknown): shape is AvatarShape =>
  typeof shape === "string" && AVATAR_SHAPES.some((item) => item.id === shape)
export const validAvatarColor = (color: unknown): color is string =>
  typeof color === "string" && /^#[\da-f]{6}$/i.test(color)

export const avatarProfileFor = (bot: AvatarIdentity): AvatarProfile => {
  const seed = bot.avatarSeed ?? bot.id
  const original = SHAPES[seededIndex(seed, "shape", SHAPES.length)]?.id
  const seededShape =
    original === "goutte" ? AVATAR_SHAPES[seededIndex(seed, "shape:replacement", AVATAR_SHAPES.length)]?.id : original
  const automatic =
    COLOR_BY_ID.get(AVATAR_COLORS[seededIndex(seed, "color", AVATAR_COLORS.length)] ?? "rouge")?.hex ?? "#e8483f"
  const storedColor = COLORS.find(
    (item) => item.id === bot.color || item.hex.toLowerCase() === bot.color?.toLowerCase(),
  )?.hex
  // Pre-picker bots used arbitrary UI accent colors. They now get an automatic identity;
  // a picker identity still retains an explicitly saved custom hex color.
  const custom = (bot.avatarShape || bot.avatarSeed) && validAvatarColor(bot.color) ? bot.color : null
  return {
    shape: validAvatarShape(bot.avatarShape) ? bot.avatarShape : (seededShape ?? "cercle"),
    color: bot.avatarHue != null ? avatarHueColor(bot.avatarHue) : (storedColor ?? custom ?? automatic),
    expression: EXPRESSIONS[seededIndex(seed, "expression", EXPRESSIONS.length)]?.id ?? "neutre",
    phase: (avatarSeedHash(seed) / 4294967296) * 1.4,
  }
}
export const avatarShapeFor = (bot: string | AvatarIdentity): AvatarShape =>
  avatarProfileFor(typeof bot === "string" ? { id: bot, color: null } : bot).shape
export const avatarColorFor = (bot: AvatarIdentity): string => avatarProfileFor(bot).color

// Some silhouettes (especially the triangle) are asymmetric around the engine's origin.
// Center their bounds in the tile, using the same registration for body and contour.
const shapeViewBoxes = new Map<AvatarShape, string>()
export const avatarViewBoxFor = (shape: AvatarShape): string => {
  const cached = shapeViewBoxes.get(shape)
  if (cached) return cached
  const radii = SHAPE_BY_ID.get(shape)?.radii ?? [1]
  const coordinates = radii.map((radius, index) => {
    const angle = (index / radii.length) * Math.PI * 2
    return { x: radius * Math.cos(angle) * RAYON, y: radius * Math.sin(angle) * RAYON }
  })
  const center = (axis: "x" | "y") =>
    (Math.min(...coordinates.map((point) => point[axis])) + Math.max(...coordinates.map((point) => point[axis]))) / 2
  const viewBox = `${center("x") - DEMI_VIEWBOX} ${center("y") - DEMI_VIEWBOX} ${DEMI_VIEWBOX * 2} ${DEMI_VIEWBOX * 2}`
  shapeViewBoxes.set(shape, viewBox)
  return viewBox
}

export const avatarMoodFor = ({
  botId,
  paused = false,
  connecting = false,
  runs = [],
  messages = [],
  notifications = [],
  recentReply = false,
}: {
  botId: string
  paused?: boolean
  connecting?: boolean
  runs?: readonly Run[]
  messages?: readonly Message[]
  notifications?: readonly NotificationRecord[]
  recentReply?: boolean
}): AvatarMood => {
  if (paused) return "asleep"
  const botRuns = runs.filter((run) => run.botId === botId)
  const lastRun = [...botRuns].sort((a, b) => b.queuedAt - a.queuedAt)[0]
  if (
    lastRun?.status === "failed" ||
    notifications.some(
      (item) =>
        item.botId === botId && item.resolvedAt === null && ["turn-failed", "routine-failed"].includes(item.kind),
    )
  )
    return "failed"
  if (
    notifications.some(
      (item) => item.botId === botId && item.resolvedAt === null && ["approval", "question"].includes(item.kind),
    ) ||
    messages.some((message) => message.parts.some((part) => part.type === "approval" && part.decision === "pending"))
  )
    return "waiting"
  if (botRuns.some((run) => ["queued", "starting", "running"].includes(run.status))) return "working"
  if (connecting) return "connecting"
  if (recentReply) return "responded"
  return "idle"
}

export const avatarPresentation = (mood: AvatarMood): AvatarPresentation => {
  const expression: Record<AvatarMood, ExpressionId | null> = {
    idle: null,
    working: "attentif",
    waiting: "curieux",
    failed: "triste",
    responded: "heureux",
    asleep: "somnolent",
    connecting: "attentif",
  }
  return {
    expression: expression[mood],
    state: mood === "connecting" ? "swirl" : "idle",
    outline: mood === "working" || mood === "connecting",
  }
}
export const avatarExpressionFor = (profile: AvatarProfile, mood: AvatarMood): ExpressionId =>
  avatarPresentation(mood).expression ?? profile.expression
// Preserve the expression's eye shapes, while removing the baked-in head tilt.
export const avatarExpressionProfile = (profile: AvatarProfile, mood: AvatarMood) => {
  const expression = EXPRESSION_BY_ID.get(avatarExpressionFor(profile, mood))
  return expression ? { ...expression, gaze: { ...expression.gaze, roll: 0 } } : null
}
export const AVATAR_STATES = ["idle", "wink", "wide", "notify", "swirl"] as const
export const setAvatarState = (engine: BotEngine, state: StateId, time: number): void => {
  if (!AVATAR_STATES.some((id) => id === state) || !STATE_BY_ID.get(state)?.baseBody)
    throw new Error(`Unsafe avatar state: ${state}`)
  engine.setState(state, time)
}
export const createAvatarEngine = (profile: AvatarProfile, mood: AvatarMood): BotEngine => {
  const engine = new BotEngine(
    RAYON,
    avatarPresentation(mood).state,
    SHAPE_BY_ID.get(profile.shape)?.radii,
    avatarExpressionProfile(profile, mood),
  )
  // Settle the initial gaze before time zero; a zero-duration morph divides 0 by 0 on the first frame.
  engine.setLook({ yaw: 0, pitch: 10, mix: 1, spin: 0, wander: 0 }, -BotEngine.LOOK_MORPH)
  return engine
}
export const avatarHasClock = (
  mood: AvatarMood,
  reducedMotion: boolean,
  motion: AvatarMotion = "hover",
  interacting = false,
  followPointer = false,
): boolean =>
  !reducedMotion && (avatarPresentation(mood).outline || motion === "always" || interacting || followPointer)

export const avatarCycle = (mood: AvatarMood, offset = 0): Block[] => {
  const held = (state: StateId): Block => {
    const block = makeBlock(state)
    return { state, duration: block.duration * 1.25 }
  }
  if (mood !== "idle") return [held(avatarPresentation(mood).state)]
  const blocks = [held("idle"), makeBlock("wink"), held("idle"), makeBlock("wide"), held("idle")]
  const start = ((Math.trunc(offset) % blocks.length) + blocks.length) % blocks.length
  return [...blocks.slice(start), ...blocks.slice(0, start)]
}

export const avatarFrameMarkup = (frame: AvatarFrame, color: string, id = "touri-avatar"): string => {
  const fill = validAvatarColor(color) ? color : "#e8483f"
  const maskId = `${id}-face`
  const eyes = frame.eyes
    .map(
      (eye) => `<path data-avatar-eye="" d="${eye.d}" transform="${eye.matrix}" opacity="${eye.alpha}" fill="#000"/>`,
    )
    .join("")
  return `<defs><mask id="${maskId}" maskUnits="userSpaceOnUse" x="-${DEMI_VIEWBOX}" y="-${DEMI_VIEWBOX}" width="${2 * DEMI_VIEWBOX}" height="${2 * DEMI_VIEWBOX}"><path d="${frame.bodyPath}" fill="#fff"/>${eyes}</mask></defs><g opacity="${frame.bodyAlpha}"><path d="${frame.bodyPath}" fill="#f9f9f9"/><rect data-avatar-body="" d="${frame.bodyPath}" x="-${DEMI_VIEWBOX}" y="-${DEMI_VIEWBOX}" width="${DEMI_VIEWBOX * 2}" height="${DEMI_VIEWBOX * 2}" fill="${fill}" mask="url(#${maskId})"/></g>`
}

/** Portable generated avatar for consumers without a DOM. */
export const renderAvatarSvg = (
  bot: AvatarIdentity,
  { size = 32, mood = "idle" }: { size?: number; mood?: AvatarMood } = {},
): string => {
  const profile = avatarProfileFor(bot)
  const state = avatarPresentation(mood).state
  const frame = createAvatarEngine(profile, mood).sample(POSES[state])
  const dimension = Number.isFinite(size) ? Math.max(1, size) : 32
  const inner = avatarFrameMarkup(frame, profile.color)
  const outline = avatarPresentation(mood).outline
    ? `<path d="${frame.bodyPath}" fill="none" stroke="${profile.color}" stroke-width="4" opacity="0.65"/>`
    : ""
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dimension}" height="${dimension}" viewBox="0 0 100 100" overflow="visible"><svg x="-14%" y="-14%" width="128%" height="128%" viewBox="${avatarViewBoxFor(profile.shape)}" overflow="visible">${inner}${outline}</svg></svg>`
}
