export type JevOption = { ref: string; name: string }
export type JevDecision = { choice: string; confidence: number; options: string[] }

// Deterministic stand-in for the assisted-choice service: picks the option that best matches the intent.
export const decideOption = (intent: string, options: readonly JevOption[]): JevDecision | undefined => {
  const normalized = intent.trim().toLowerCase()
  const exact = options.find((option) => option.name.toLowerCase().startsWith(`${normalized},`))
  const best = exact ?? options.find((option) => option.name.toLowerCase().startsWith(normalized))
  if (!best) return undefined

  return {
    choice: best.name,
    confidence: exact ? 0.97 : 0.7,
    options: options.map((option) => option.name),
  }
}
