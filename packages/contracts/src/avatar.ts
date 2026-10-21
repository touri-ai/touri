import { type AvatarAnchor, type AvatarHeadGeometry, getAvatarHeadGeometry } from "./avatar-head"
import type {
  AvatarAccessory,
  AvatarBullShape,
  AvatarHorns,
  AvatarLegacyShape,
  AvatarShape,
  Bot,
  Message,
  NotificationRecord,
  Run,
} from "./types"

export { getAvatarHeadGeometry } from "./avatar-head"

export type AvatarHue = 0 | 30 | 55 | 100 | 150 | 185 | 215 | 245 | 280 | 320
export type AvatarIdentity = Pick<Bot, "id" | "color"> &
  Pick<Partial<Bot>, "avatarShape" | "avatarSeed" | "avatarPath"> & { avatarHue?: AvatarHue | null }
export type AvatarMood = "idle" | "working" | "waiting" | "failed" | "responded" | "asleep" | "connecting"
export type AvatarMotion = "hover" | "idle" | "always"
/** The seven animated states of the bull, matching the UI's mascot phases. */
export type AvatarPhase = "idle" | "thinking" | "working" | "waiting" | "done" | "failed" | "asleep"
export type AvatarLook = {
  color: string
  horns: AvatarHorns
  accessory: AvatarAccessory
  headShape?: AvatarLegacyShape
}
export type AvatarProfile = AvatarLook & { shape: AvatarBullShape; headShape: AvatarLegacyShape; offset: number }
/** One vector layer; stroked layers (`stroke`, `width`) draw with round caps and no fill. */
export type AvatarPath = { d: string; fill: string; stroke?: string; width?: number; transform?: string }
export type AvatarEffect = { id: string; paths: AvatarPath[] }
export type AvatarBull = {
  color: string
  head: string
  /** Horns, ears and head: the outline the aura follows. */
  silhouette: string[]
  /** Thinking and working glow around the silhouette, like the pulsing outline of the blob avatars. */
  aura: boolean
  body: AvatarPath[]
  eyes: AvatarPath[]
  blink: boolean
  accessory: AvatarPath[]
  effects: AvatarEffect[]
}

/** Seconds of one blink cycle; profiles spread their offsets over it so neighbours never blink together. */
export const AVATAR_BLINK_SECONDS = 4.2
/** Centres the bull, horns to chin, in its tile; effects may overflow the top. */
export const AVATAR_VIEWBOX = "0 2 100 100"
export const AVATAR_HORNS: readonly AvatarHorns[] = ["classic", "short", "long", "none"]
export const AVATAR_ACCESSORIES: readonly AvatarAccessory[] = [
  "none",
  "ring",
  "glasses",
  "headphones",
  "cap",
  "flower",
  "crown",
]
export const AVATAR_SHAPES: readonly AvatarBullShape[] = AVATAR_HORNS.flatMap((horns) =>
  AVATAR_ACCESSORIES.map((accessory): AvatarBullShape => `${horns}-${accessory}`),
)
// Silhouettes saved before the bulls also form the seeded head palette.
export const LEGACY_AVATAR_SHAPES: readonly AvatarLegacyShape[] = [
  "cercle",
  "galet",
  "squircle",
  "capsule",
  "triangle",
  "hexagone",
  "nuage",
]
const PALETTE = [
  { id: "rouge", hex: "#e8483f" },
  { id: "orange", hex: "#f08a24" },
  { id: "ambre", hex: "#f0b429" },
  { id: "vert", hex: "#3ecf8e" },
  { id: "turquoise", hex: "#2fbfa0" },
  { id: "bleu", hex: "#3b93f0" },
  { id: "violet", hex: "#8b5cf6" },
  { id: "rose", hex: "#e152b0" },
  { id: "gris", hex: "#a3a3a3" },
] as const
export const AVATAR_COLORS = PALETTE.filter((color) => color.id !== "gris").map((color) => color.id)
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
  hex: PALETTE.find((item) => item.id === color)?.hex ?? "#0a0a0c",
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
  isBullShape(shape) || isLegacyShape(shape) || getCustomShape(shape) !== undefined
const isBullShape = (shape: unknown): shape is AvatarBullShape => AVATAR_SHAPES.some((item) => item === shape)
const isLegacyShape = (shape: unknown): shape is AvatarLegacyShape =>
  LEGACY_AVATAR_SHAPES.some((item) => item === shape)
export const validAvatarColor = (color: unknown): color is string =>
  typeof color === "string" && /^#[\da-f]{6}$/i.test(color)
export const avatarShapeOf = (horns: AvatarHorns, accessory: AvatarAccessory): AvatarBullShape =>
  `${horns}-${accessory}`

export const avatarProfileFor = (bot: AvatarIdentity): AvatarProfile => {
  const seed = bot.avatarSeed ?? bot.id
  const customShape = getCustomShape(bot.avatarShape)
  const shape = customShape?.look ?? getBullShape(bot.avatarShape, seed)
  const headShape = customShape?.head ?? getAvatarHeadShape(bot.avatarShape, seed)
  const [horns, accessory] = getLookParts(shape)
  const automatic = PALETTE[seededIndex(seed, "color", AVATAR_COLORS.length)]?.hex ?? "#e8483f"
  const storedColor = PALETTE.find(
    (item) => item.id === bot.color || item.hex.toLowerCase() === bot.color?.toLowerCase(),
  )?.hex
  // Pre-picker bots used arbitrary UI accent colors. They now get an automatic identity;
  // a picker identity still retains an explicitly saved custom hex color.
  const custom = (bot.avatarShape || bot.avatarSeed) && validAvatarColor(bot.color) ? bot.color : null
  const color = bot.avatarHue != null ? avatarHueColor(bot.avatarHue) : (storedColor ?? custom ?? automatic)

  return {
    shape,
    headShape,
    horns,
    accessory,
    color,
    offset: (avatarSeedHash(seed) / 4294967296) * AVATAR_BLINK_SECONDS,
  }
}
export const avatarShapeFor = (bot: string | AvatarIdentity): AvatarShape => {
  const identity: AvatarIdentity = typeof bot === "string" ? { id: bot, color: null } : bot
  if (validAvatarShape(identity.avatarShape)) return identity.avatarShape

  return avatarProfileFor(identity).shape
}
export const avatarColorFor = (bot: AvatarIdentity): string => avatarProfileFor(bot).color

/** Retains an explicitly stored head without changing the seed or other identity fields. */
export const getAvatarShapeForLook = (
  bot: AvatarIdentity,
  horns: AvatarHorns,
  accessory: AvatarAccessory,
): AvatarShape => {
  const look = avatarShapeOf(horns, accessory)
  const head = getCustomShape(bot.avatarShape)?.head ?? bot.avatarShape
  if (isLegacyShape(head)) return `${head}:${look}`

  return look
}

const getCustomShape = (shape: unknown): { head: AvatarLegacyShape; look: AvatarBullShape } | undefined => {
  if (typeof shape !== "string" || shape.length > 40) return undefined
  const [head, look, extra] = shape.split(":")
  if (extra !== undefined || !isLegacyShape(head) || !isBullShape(look)) return undefined

  return { head, look }
}
const getBullShape = (shape: unknown, seed: string): AvatarBullShape => {
  if (isBullShape(shape)) return shape

  return getSeededShape(seed)
}
const getAvatarHeadShape = (shape: unknown, seed: string): AvatarLegacyShape => {
  if (isLegacyShape(shape)) return shape

  return LEGACY_AVATAR_SHAPES[seededIndex(seed, "shape", LEGACY_AVATAR_SHAPES.length)] ?? "cercle"
}

const getSeededShape = (seed: string): AvatarBullShape =>
  avatarShapeOf(
    AVATAR_HORNS[seededIndex(seed, "horns", AVATAR_HORNS.length)] ?? "classic",
    AVATAR_ACCESSORIES[seededIndex(seed, "accessory", AVATAR_ACCESSORIES.length)] ?? "none",
  )
const getLookParts = (shape: AvatarBullShape): [AvatarHorns, AvatarAccessory] => {
  const horns = AVATAR_HORNS.find((item) => shape.startsWith(`${item}-`)) ?? "classic"
  const accessory = AVATAR_ACCESSORIES.find((item) => shape === `${horns}-${item}`) ?? "none"

  return [horns, accessory]
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

const MOOD_PHASES: Record<AvatarMood, AvatarPhase> = {
  idle: "idle",
  working: "working",
  waiting: "waiting",
  failed: "failed",
  responded: "done",
  asleep: "asleep",
  connecting: "thinking",
}
export const avatarPhaseForMood = (mood: AvatarMood): AvatarPhase => MOOD_PHASES[mood]

/** Draws the touri bull: the pixel design's proportions as smooth vector shapes, with an ink outline and pill eyes. */
export const avatarBullFor = (look: AvatarLook, phase: AvatarPhase): AvatarBull => {
  const color = validAvatarColor(look.color) ? look.color : "#e8483f"
  const shades = getShadesFor(color)
  const geometry = getAvatarHeadGeometry(look.headShape ?? "galet")
  const horns = getAnchoredSides(HORN_PATHS[look.horns], geometry.horns, HORN_ORIGIN)
  const hornShades = getAnchoredSides(HORN_SHADE_PATHS[look.horns], geometry.horns, HORN_ORIGIN)
  const ears = getAnchoredSides(EAR, geometry.ears, EAR_ORIGIN)
  const pose = PHASE_POSES[phase]
  const silhouette = horns.concat(ears, geometry.path)
  const outline: AvatarPath[] = silhouette.map((d) => ({
    d,
    fill: shades.ink,
    stroke: shades.ink,
    width: INK_WIDTH * 2,
  }))
  const snout = getPlacedLayers(
    [
      { d: SNOUT, fill: shades.snout },
      { d: `${getEllipse(40, 79.5, 3.3, 4.4)}${getEllipse(60, 79.5, 3.3, 4.4)}`, fill: shades.nostril },
    ],
    geometry.snout,
    SNOUT_ORIGIN,
  )
  const brows = getBothSides(BROW_PATHS[pose.eyes]).map((d) => ({
    d,
    fill: "none",
    stroke: shades.ink,
    width: 4.6,
  }))

  return {
    color,
    head: geometry.path,
    silhouette,
    aura: phase === "thinking" || phase === "working",
    body: outline.concat(
      getFillLayers(horns, HORN),
      getFillLayers(hornShades, HORN_SHADE),
      getFillLayers(ears, color),
      getFillLayers(getAnchoredSides(EAR_INNER, geometry.ears, EAR_ORIGIN), shades.ear),
      { d: geometry.path, fill: color },
      getPlacedLayers(getFillLayers(getBothSides(TUFT), shades.tuft), geometry.forehead, TUFT_ORIGIN),
      snout,
      getPlacedLayers(brows, geometry.eyes, EYE_ORIGIN),
    ),
    eyes: getPlacedLayers(EYE_PATHS[pose.eyes], geometry.eyes, EYE_ORIGIN),
    blink: pose.blink,
    accessory: getAccessoryLayers(look.accessory, geometry, shades.ink),
    effects: getEffects(pose.effects, geometry),
  }
}

/** Portable still avatar for consumers without a DOM. */
export const renderAvatarSvg = (
  bot: AvatarIdentity,
  { size = 32, mood = "idle" }: { size?: number; mood?: AvatarMood } = {},
): string => {
  const bull = avatarBullFor(avatarProfileFor(bot), avatarPhaseForMood(mood))
  const dimension = Number.isFinite(size) ? Math.max(1, size) : 32
  const aura = bull.aura
    ? `<g opacity="0.38">${bull.silhouette.map((d) => getPathMarkup({ d, fill: bull.color, stroke: bull.color, width: AVATAR_AURA_WIDTH })).join("")}</g>`
    : ""
  const paths = bull.body.concat(
    bull.eyes,
    bull.accessory,
    bull.effects.flatMap((effect) => effect.paths),
  )

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dimension}" height="${dimension}" viewBox="${AVATAR_VIEWBOX}" overflow="visible" stroke-linecap="round" stroke-linejoin="round">${aura}${paths.map(getPathMarkup).join("")}</svg>`
}
/** Stroke width of the aura drawn around `silhouette`. */
export const AVATAR_AURA_WIDTH = 17

type Eyes = "open" | "up" | "focused" | "wide" | "happy" | "sad" | "closed"
type AccessoryLayer = AvatarPath & { inked?: boolean }

const INK_WIDTH = 3.5
const EYE_WHITE = "#ffffff"
const HORN = "#f3f3f5"
const HORN_SHADE = "#c6c6cd"
const EFFECT_GREY = "#9a9aa0"
const GOLD = "#febc2e"
const SILVER = "#d1d1d6"
// Registrations of the reusable artwork; each head places these features independently.
const HORN_ORIGIN = { x: 28, y: 36 }
const EAR_ORIGIN = { x: 17, y: 51.5 }
const SNOUT_ORIGIN = { x: 50, y: 79.5 }
const EYE_ORIGIN = { x: 50, y: 56 }
const FOREHEAD_ORIGIN = { x: 50, y: 35 }
// Tufts sit below the hat registration so they stay inside curved foreheads.
const TUFT_ORIGIN = { x: 50, y: 31 }
// The broad rounded snout keeps the original pixel bull's chin.
const SNOUT =
  "M30 66.5H70C75.5 66.5 80 69.5 82 74C81.2 76.8 80.2 79.5 79 82C74 89 64 93 50 93C36 93 26 89 21 82C19.8 79.5 18.8 76.8 18 74C20 69.5 24.5 66.5 30 66.5Z"
// Left-side outlines; `getBothSides` mirrors each one across the vertical centre line.
const EAR = "M17 45C10 42 3 44 1 49C3 56 10 59 17 58Z"
const EAR_INNER = "M15 48C10 46.5 6 47.5 4.5 50C6 53.5 10 55 15 54.5Z"
const TUFT = "M29 35.5C33 33.6 38 33.4 42 34.6C39.5 37.4 33.5 38.4 29 35.5Z"
const HORN_PATHS: Record<AvatarHorns, string | null> = {
  classic: "M22 40C16 33 12 24 11 13C11 9.5 14.5 8.5 16 11.5C19 21 25 28 35 33Z",
  short: "M24 38C20 32 19 27 20 21C20 18 23 17.5 24.5 20C26 25 29 29 34 33Z",
  long: "M21 41C11 37 4 29 2 13C1.6 9.6 5 8.6 6.2 11.6C9 23 16 30 34 33Z",
  none: null,
}
// The lower part of each horn, shaded like the pixel horn's grey base.
const HORN_SHADE_PATHS: Record<AvatarHorns, string | null> = {
  classic: "M22 40C18.4 35.6 15 29.4 13.1 23.4Q17.6 25.6 22.4 25C25.6 28.4 29.8 31 35 33Z",
  short: "M24 38C22 34.8 20.6 30.6 20.1 26.6Q23 27.6 25.9 26.6C27.8 29.4 30.6 31.6 34 33Z",
  long: "M21 41C14.8 38.4 9.6 34 6.4 27.6Q11 29.6 15.6 28.4C20 31 26 32.6 34 33Z",
  none: null,
}
// Brows carry the pixel bull's frown; each state bends them.
const BROW_PATHS: Record<Eyes, string> = {
  open: "M23 46L37.5 48",
  up: "M23 42L38 42.5",
  focused: "M22.5 47L38 50.5",
  wide: "M23 43L38 42",
  happy: "M23 46L38 46",
  sad: "M23 49.5L38 44.5",
  closed: "M23 49L38 49",
}

const getEyes = (left: string, width: number): AvatarPath[] =>
  getBothSides(left).map((d) => ({ d, fill: "none", stroke: EYE_WHITE, width }))
const EYE_PATHS: Record<Eyes, AvatarPath[]> = {
  open: getEyes("M31 52.5L31 59.5", 7.5),
  up: getEyes("M32.5 49L32.5 54.5", 7.5),
  focused: getEyes("M31 55.5L31 59", 7.5),
  wide: [
    { d: getEllipse(31, 55.5, 6.6, 6.6), fill: EYE_WHITE },
    { d: getEllipse(69, 55.5, 6.6, 6.6), fill: EYE_WHITE },
  ],
  happy: getEyes("M25.5 59Q31 50.5 36.5 59", 4),
  sad: getEyes("M33.5 52L29 60", 6),
  closed: getEyes("M25.5 56Q31 61.5 36.5 56", 3.8),
}
const GLASSES_FRAMES =
  "M21.5 49.5h19a3.5 3.5 0 0 1 3.5 3.5v6a6 6 0 0 1-6 6h-14a6 6 0 0 1-6-6v-6a3.5 3.5 0 0 1 3.5-3.5ZM59.5 49.5h19a3.5 3.5 0 0 1 3.5 3.5v6a6 6 0 0 1-6 6h-14a6 6 0 0 1-6-6v-6a3.5 3.5 0 0 1 3.5-3.5Z"
const ACCESSORY_PATHS: Record<AvatarAccessory, AccessoryLayer[]> = {
  none: [],
  ring: [{ d: "M43 84C43 94.5 57 94.5 57 84", fill: "none", stroke: "#d8d8de", width: 3.6, inked: true }],
  glasses: [
    { d: GLASSES_FRAMES, fill: "#ffffff33" },
    {
      d: `${GLASSES_FRAMES}M44 54Q50 51 56 54M18 53L11 50.5M82 53L89 50.5`,
      fill: "none",
      stroke: "#f5f5f7",
      width: 3.2,
    },
  ],
  headphones: [
    { d: "M13 49C11 15 89 15 87 49", fill: "none", stroke: SILVER, width: 5.5, inked: true },
    {
      d: "M3.5 46a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v12a5 5 0 0 1-5 5h-4a5 5 0 0 1-5-5ZM82.5 46a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v12a5 5 0 0 1-5 5h-4a5 5 0 0 1-5-5Z",
      fill: SILVER,
      inked: true,
    },
    { d: "M9.5 63C9.5 74 15 81 23 82.5", fill: "none", stroke: SILVER, width: 3 },
    { d: getEllipse(24.5, 82.5, 3.2, 3.2), fill: "#0a84ff" },
  ],
  cap: [
    { d: "M24 37C24 16.5 76 16.5 76 37Z", fill: "#f5f5f7", inked: true },
    { d: "M50 18.5V36", fill: "none", stroke: "#c7c7cc", width: 2 },
    {
      d: "M17 38C29 33 71 33 83 38C84.6 38.8 84.2 42 82 42.4C70 39.4 30 39.4 18 42.4C15.8 42 15.4 38.8 17 38Z",
      fill: "#a1a1a6",
      inked: true,
    },
    { d: getEllipse(50, 18.5, 3, 2.4), fill: "#a1a1a6" },
  ],
  flower: [
    {
      d: [0, 72, 144, 216, 288]
        .map((angle) => (angle * Math.PI) / 180)
        .map((angle) => getEllipse(82 + Math.sin(angle) * 5.2, 33 - Math.cos(angle) * 5.2, 4.4, 4.4))
        .join(""),
      fill: "#ff8cc8",
      inked: true,
    },
    { d: getEllipse(82, 33, 3.4, 3.4), fill: GOLD },
  ],
  crown: [
    { d: "M34 35L32.5 15.5L42 24L50 9.5L58 24L67.5 15.5L66 35Z", fill: GOLD, inked: true },
    { d: `${getEllipse(41.5, 29.5, 2.6, 2.6)}${getEllipse(58.5, 29.5, 2.6, 2.6)}`, fill: "#e5322d" },
  ],
}
const PHASE_POSES: Record<AvatarPhase, { eyes: Eyes; blink: boolean; effects: AvatarEffect[] }> = {
  idle: { eyes: "open", blink: true, effects: [] },
  thinking: {
    eyes: "up",
    blink: true,
    effects: [38, 50, 62].map((x, index) => ({
      id: `dot-${index + 1}`,
      paths: [{ d: getEllipse(x, 15, 3.6, 3.6), fill: EFFECT_GREY }],
    })),
  },
  working: {
    eyes: "focused",
    blink: true,
    effects: [
      { id: "steam-left", paths: [{ d: getPuff(13, 88, 4.2), fill: EFFECT_GREY }] },
      { id: "steam-right", paths: [{ d: getPuff(87, 88, 4.2), fill: EFFECT_GREY }] },
    ],
  },
  waiting: {
    eyes: "wide",
    blink: true,
    effects: [
      {
        id: "alert",
        paths: [{ d: `M46 2.5h8l-1.5 17h-5Z${getEllipse(50, 25.5, 3.6, 3.6)}`, fill: "#0a84ff" }],
      },
    ],
  },
  done: {
    eyes: "happy",
    blink: false,
    effects: [
      { id: "sparkle-1", paths: [{ d: getSparkle(33, 15, 8), fill: GOLD }] },
      { id: "sparkle-2", paths: [{ d: getSparkle(67, 8, 6), fill: GOLD }] },
    ],
  },
  failed: {
    eyes: "sad",
    blink: false,
    effects: [
      {
        id: "smoke",
        paths: [
          {
            d: `${getEllipse(44, 19, 5, 5)}${getEllipse(52, 14, 6.5, 6.5)}${getEllipse(59, 19.5, 4.5, 4.5)}${getEllipse(51, 21, 5, 5)}`,
            fill: EFFECT_GREY,
          },
        ],
      },
      {
        id: "tear",
        paths: [
          { d: "M26 62C26 62 22.5 66.5 22.5 68.8A3.5 3.5 0 0 0 29.5 68.8C29.5 66.5 26 62 26 62Z", fill: "#64b5ff" },
        ],
      },
    ],
  },
  asleep: {
    eyes: "closed",
    blink: false,
    effects: [
      { id: "snore-1", paths: [{ d: "M62 17h8l-8 9h8", fill: "none", stroke: EFFECT_GREY, width: 3.2 }] },
      { id: "snore-2", paths: [{ d: "M76 2h11l-11 12.5h11", fill: "none", stroke: EFFECT_GREY, width: 3.8 }] },
    ],
  },
}

const getShadesFor = (color: string) => {
  const snout = color.toLowerCase() === "#f0b429" ? "#ffe2b8" : "#ffc94d"

  return {
    ink: mixColor(color, "#140808", 0.78),
    ear: mixColor(color, "#ffffff", 0.4),
    tuft: mixColor(color, "#ffffff", 0.28),
    snout,
    nostril: mixColor(snout, "#3c1e00", 0.72),
  }
}
const mixColor = (from: string, to: string, amount: number): string => {
  const channels = (hex: string) => [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16))
  const target = channels(to)
  const mixed = channels(from).map((value, index) => Math.round(value + ((target[index] ?? value) - value) * amount))

  return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`
}
// Accessories that leave the face get the head's ink outline, so light ones still read on a light theme.
const getInked = (path: AvatarPath, ink: string): AvatarPath => ({
  d: path.d,
  fill: path.fill === "none" ? "none" : ink,
  stroke: ink,
  width: (path.width ?? 0) + INK_WIDTH + 1.5,
})
const getLayer = ({ d, fill, stroke, width }: AccessoryLayer): AvatarPath =>
  stroke ? { d, fill, stroke, width: width ?? 1 } : { d, fill }
const getPathMarkup = (path: AvatarPath): string => {
  const transform = path.transform ? ` transform="${path.transform}"` : ""
  if (path.stroke)
    return `<path d="${path.d}" fill="${path.fill}" stroke="${path.stroke}" stroke-width="${path.width ?? 1}"${transform}/>`

  return `<path d="${path.d}" fill="${path.fill}"${transform}/>`
}

type AvatarPoint = Readonly<{ x: number; y: number }>

const getFillLayers = (paths: readonly string[], fill: string): AvatarPath[] => paths.map((d) => ({ d, fill }))
const getCoordinate = (value: number): number => Number(value.toFixed(3))
const getTransform = (anchor: AvatarAnchor, origin: AvatarPoint): string => {
  const x = getCoordinate(anchor.x - origin.x * anchor.scaleX)
  const y = getCoordinate(anchor.y - origin.y * anchor.scaleY)

  return `matrix(${anchor.scaleX} 0 0 ${anchor.scaleY} ${x} ${y})`
}
const getPlacedLayers = (paths: readonly AvatarPath[], anchor: AvatarAnchor, origin: AvatarPoint): AvatarPath[] => {
  const transform = getTransform(anchor, origin)

  return paths.map((path) => getPlacedLayer(path, transform))
}
const getPlacedLayer = (path: AvatarPath, transform: string): AvatarPath => {
  if (path.stroke) return { d: path.d, fill: path.fill, stroke: path.stroke, width: path.width ?? 1, transform }

  return { d: path.d, fill: path.fill, transform }
}

// These outlines use only absolute M/L/C/Q coordinates, keeping the aura on the same placed geometry.
const getAnchoredSides = (left: string | null, anchor: AvatarAnchor, origin: AvatarPoint): string[] => {
  if (!left) return []
  const placed = left.replace(/(-?[\d.]+) (-?[\d.]+)/g, (_, x: string, y: string) => {
    const placedX = getCoordinate(anchor.x + (Number(x) - origin.x) * anchor.scaleX)
    const placedY = getCoordinate(anchor.y + (Number(y) - origin.y) * anchor.scaleY)

    return `${placedX} ${placedY}`
  })

  return getBothSides(placed)
}

const getAccessoryLayers = (accessory: AvatarAccessory, geometry: AvatarHeadGeometry, ink: string): AvatarPath[] => {
  const placements = {
    none: { anchor: geometry.forehead, origin: FOREHEAD_ORIGIN },
    ring: { anchor: geometry.snout, origin: SNOUT_ORIGIN },
    glasses: { anchor: geometry.eyes, origin: EYE_ORIGIN },
    headphones: { anchor: geometry.headphones, origin: { x: 50, y: 50 } },
    cap: { anchor: geometry.forehead, origin: FOREHEAD_ORIGIN },
    flower: { anchor: geometry.temple, origin: { x: 82, y: 33 } },
    crown: { anchor: geometry.forehead, origin: FOREHEAD_ORIGIN },
  }
  const placement = placements[accessory]
  const paths = ACCESSORY_PATHS[accessory].flatMap((path) =>
    path.inked ? [getInked(path, ink), getLayer(path)] : [getLayer(path)],
  )

  return getPlacedLayers(paths, placement.anchor, placement.origin)
}

const getEffects = (effects: readonly AvatarEffect[], geometry: AvatarHeadGeometry): AvatarEffect[] =>
  effects.map((effect) => ({ id: effect.id, paths: getEffectLayers(effect, geometry) }))

const getEffectLayers = (effect: AvatarEffect, geometry: AvatarHeadGeometry): AvatarPath[] => {
  if (effect.id.startsWith("steam-")) return getPlacedLayers(effect.paths, geometry.snout, SNOUT_ORIGIN)
  if (effect.id === "tear") return getPlacedLayers(effect.paths, geometry.eyes, EYE_ORIGIN)

  return getPlacedLayers(effect.paths, geometry.forehead, FOREHEAD_ORIGIN)
}

// Mirrors absolute `x y` pairs (M, L, C, Q) across x = 50; arcs and relative commands must not be passed in.
function getBothSides(left: string): [string, string] {
  return [
    left,
    left.replace(/(-?[\d.]+) (-?[\d.]+)/g, (_, x: string, y: string) => `${+(100 - Number(x)).toFixed(2)} ${y}`),
  ]
}
function getEllipse(cx: number, cy: number, rx: number, ry: number): string {
  return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${rx * 2} 0a${rx} ${ry} 0 1 0 ${-rx * 2} 0Z`
}
function getPuff(cx: number, cy: number, radius: number): string {
  return `${getEllipse(cx, cy, radius, radius)}${getEllipse(cx + radius * 0.9, cy - radius * 0.55, radius * 0.8, radius * 0.8)}${getEllipse(cx - radius * 0.85, cy - radius * 0.4, radius * 0.7, radius * 0.7)}`
}
function getSparkle(cx: number, cy: number, radius: number): string {
  const near = radius * 0.12
  const curve = (x: number, y: number, toX: number, toY: number) => `C${x} ${y} ${x} ${y} ${toX} ${toY}`

  return `M${cx} ${cy - radius}${curve(cx + near, cy - near, cx + radius, cy)}${curve(cx + near, cy + near, cx, cy + radius)}${curve(cx - near, cy + near, cx - radius, cy)}${curve(cx - near, cy - near, cx, cy - radius)}Z`
}
