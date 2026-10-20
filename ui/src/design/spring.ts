export type Spring = { frequency: number; damping: number; duration: number; samples?: number }

/** Sample the displacement of a unit spring released at rest into a CSS easing. */
export const springToLinear = ({ frequency, damping, duration, samples = 80 }: Spring): string => {
  if (
    ![frequency, damping, duration, samples].every(Number.isFinite) ||
    frequency <= 0 ||
    damping <= 0 ||
    damping > 1 ||
    duration <= 0 ||
    !Number.isInteger(samples) ||
    samples < 2 ||
    samples > 1000
  )
    throw new RangeError("Invalid spring parameters")
  const angular = frequency * 2 * Math.PI
  const damped = angular * Math.sqrt(1 - damping ** 2)
  const points = Array.from({ length: samples + 1 }, (_, index) => {
    if (index === 0) return "0"
    if (index === samples) return "1"
    const time = (index / samples) * (duration / 1000)
    const decay = Math.exp(-damping * angular * time)
    const displacement =
      damping === 1
        ? decay * (1 + angular * time)
        : decay * (Math.cos(damped * time) + ((damping * angular) / damped) * Math.sin(damped * time))
    return String(Number((1 - displacement).toFixed(5)))
  })
  return `linear(${points.join(", ")})`
}

export const motionTiers = {
  quick: { frequency: 12, damping: 1, duration: 120 },
  surface: { frequency: 7, damping: 1, duration: 200 },
  standard: { frequency: 4.5, damping: 1, duration: 320 },
  slow: { frequency: 2.5, damping: 1, duration: 650 },
  bounce: { frequency: 4, damping: 0.55, duration: 650 },
} satisfies Record<string, Spring>

// Compile shared curves once, before any surface opens; animation stays entirely in CSS.
const compiledSprings = new Map<Spring, string>(
  Object.values(motionTiers).map((spring) => [spring, springToLinear(spring)]),
)

export const springEasing = (spring: Spring, reduced = false): string => {
  if (reduced) return "linear"
  const easing = compiledSprings.get(spring) ?? springToLinear(spring)
  return typeof CSS !== "undefined" && CSS.supports && !CSS.supports("animation-timing-function", easing)
    ? "ease-out"
    : easing
}

export const installMotionTokens = (element: HTMLElement): void => {
  element.dataset.motionProperties =
    typeof CSS !== "undefined" && typeof CSS.registerProperty === "function" ? "registered" : "fallback"
  for (const [name, spring] of Object.entries(motionTiers)) {
    element.style.setProperty(`--ease-${name}`, springEasing(spring))
    element.style.setProperty(`--duration-${name}`, `${spring.duration}ms`)
  }
}
