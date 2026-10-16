import { expect, test, vi } from "vitest"
import { installMotionTokens, motionTiers, springEasing, springToLinear } from "../src/design/spring"

const samples = (curve: string): number[] => curve.slice(7, -1).split(", ").map(Number)

test.each(Object.entries(motionTiers))("%s compiles to finite CSS linear samples with exact endpoints", (_, tier) => {
  const curve = springToLinear(tier)
  const points = samples(curve)
  expect(curve).toMatch(/^linear\(0, .*1\)$/)
  expect(points).toHaveLength(81)
  expect(points.every(Number.isFinite)).toBe(true)
  expect(points[0]).toBe(0)
  expect(points.at(-1)).toBe(1)
  expect(Math.abs((points.at(-2) ?? 0) - 1)).toBeLessThan(0.002)
})

test("standard and slow springs settle without reversing direction", () => {
  for (const tier of [motionTiers.standard, motionTiers.slow]) {
    const points = samples(springToLinear(tier))
    expect(points.every((point, index) => point >= (points[index - 1] ?? 0) && point <= 1)).toBe(true)
  }
})

test("bounce peak matches the damped oscillator's physical overshoot", () => {
  const { damping } = motionTiers.bounce
  const peak = 1 + Math.exp((-damping * Math.PI) / Math.sqrt(1 - damping ** 2))
  const points = samples(springToLinear({ ...motionTiers.bounce, samples: 1000 }))
  expect(Math.max(...points)).toBeCloseTo(peak, 4)
  expect(points.some((point) => point > 1)).toBe(true)
})

test.each([
  { frequency: 0 },
  { frequency: Number.NaN },
  { damping: 0 },
  { damping: 1.1 },
  { duration: -1 },
  { duration: Number.POSITIVE_INFINITY },
  { samples: 1 },
  { samples: 3.5 },
  { samples: 1001 },
])("rejects invalid or unbounded input %j", (invalid) => {
  expect(() => springToLinear({ ...motionTiers.standard, ...invalid })).toThrow(RangeError)
})

test("installs all generated tiers as CSS motion tokens", () => {
  const element = document.createElement("div")
  installMotionTokens(element)
  for (const [name, tier] of Object.entries(motionTiers)) {
    expect(element.style.getPropertyValue(`--ease-${name}`)).toBe(springToLinear(tier))
    expect(element.style.getPropertyValue(`--duration-${name}`)).toBe(`${tier.duration}ms`)
  }
})

test("older webviews receive a supported easing for CSS and native animation", () => {
  vi.stubGlobal("CSS", { supports: () => false })
  try {
    const element = document.createElement("div")
    installMotionTokens(element)
    expect(element.style.getPropertyValue("--ease-standard")).toBe("ease-out")
    expect(springEasing(motionTiers.standard)).toBe("ease-out")
  } finally {
    vi.unstubAllGlobals()
  }
})

test("reduced motion has a straight easing even when CSS springs are supported", () => {
  vi.stubGlobal("CSS", { supports: () => true })
  try {
    for (const spring of Object.values(motionTiers)) expect(springEasing(spring, true)).toBe("linear")
  } finally {
    vi.unstubAllGlobals()
  }
})

test.each([true, false])("detects registered properties for ink and reveal fallback (%s)", (supported) => {
  vi.stubGlobal("CSS", { supports: () => true, ...(supported ? { registerProperty: () => undefined } : {}) })
  try {
    const element = document.createElement("div")
    installMotionTokens(element)
    expect(element.dataset.motionProperties).toBe(supported ? "registered" : "fallback")
  } finally {
    vi.unstubAllGlobals()
  }
})
