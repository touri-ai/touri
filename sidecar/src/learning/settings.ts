import type { Database } from "bun:sqlite"
import type { BotLearningSettings, Id, Kernel } from "@touri/contracts"

export const LEARNING_DEFAULTS: BotLearningSettings = {
  memory: false,
  skills: false,
  memoryEveryTurns: 10,
  skillsAfterToolCalls: 10,
}

export type LearningState = { turns: number; toolCalls: number; reviewThreadId: Id | null }

const EMPTY_STATE: LearningState = { turns: 0, toolCalls: 0, reviewThreadId: null }

export const MEMORY_TOOLS: ReadonlySet<string> = new Set(["memory_write"])
export const SKILL_TOOLS: ReadonlySet<string> = new Set(["skill_create", "skill_patch", "skill_archive"])

const readJson = (kernel: Kernel, key: string): Record<string, unknown> | null => {
  try {
    const row = (kernel.db as Database).query("SELECT value_json FROM settings WHERE key = ?").get(key) as {
      value_json: string
    } | null
    const value = row ? JSON.parse(row.value_json) : null
    return value && typeof value === "object" && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

const writeJson = (kernel: Kernel, key: string, value: unknown): void => {
  ;(kernel.db as Database)
    .query(`INSERT INTO settings(key, value_json, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
    .run(key, JSON.stringify(value), Date.now())
}

const boundedInteger = (value: unknown, { min, max, fallback }: { min: number; max: number; fallback: number }) =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback

export const INTERVAL_LIMITS = {
  memoryEveryTurns: { min: 1, max: 100 },
  skillsAfterToolCalls: { min: 1, max: 500 },
} as const

export const readLearning = (kernel: Kernel, botId: Id): BotLearningSettings => {
  const stored = readJson(kernel, `learning:${botId}`) ?? {}
  return {
    memory: stored.memory === true,
    skills: stored.skills === true,
    memoryEveryTurns: boundedInteger(stored.memoryEveryTurns, {
      ...INTERVAL_LIMITS.memoryEveryTurns,
      fallback: LEARNING_DEFAULTS.memoryEveryTurns,
    }),
    skillsAfterToolCalls: boundedInteger(stored.skillsAfterToolCalls, {
      ...INTERVAL_LIMITS.skillsAfterToolCalls,
      fallback: LEARNING_DEFAULTS.skillsAfterToolCalls,
    }),
  }
}

/** Returns the saved settings, or an error message when the patch is invalid. */
export const writeLearning = (
  kernel: Kernel,
  botId: Id,
  patch: unknown,
): { success: true; settings: BotLearningSettings } | { success: false; error: string } => {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    return { success: false, error: "Invalid learning settings" }
  const input = patch as Record<string, unknown>
  const next = { ...readLearning(kernel, botId) }
  for (const key of Object.keys(input)) {
    const value = input[key]
    if (key === "memory" || key === "skills") {
      if (typeof value !== "boolean") return { success: false, error: `${key} must be a boolean` }
      next[key] = value
    } else if (key === "memoryEveryTurns" || key === "skillsAfterToolCalls") {
      const { min, max } = INTERVAL_LIMITS[key]
      if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
        return { success: false, error: `${key} must be an integer from ${min} to ${max}` }
      next[key] = value
    } else return { success: false, error: `Unknown learning setting ${key}` }
  }
  writeJson(kernel, `learning:${botId}`, next)
  return { success: true, settings: next }
}

export const readLearningState = (kernel: Kernel, botId: Id): LearningState => {
  const stored = readJson(kernel, `learning-state:${botId}`)
  if (!stored) return { ...EMPTY_STATE }
  return {
    turns: boundedInteger(stored.turns, { min: 0, max: 1_000_000, fallback: 0 }),
    toolCalls: boundedInteger(stored.toolCalls, { min: 0, max: 1_000_000, fallback: 0 }),
    reviewThreadId: typeof stored.reviewThreadId === "string" ? stored.reviewThreadId : null,
  }
}

export const writeLearningState = (kernel: Kernel, botId: Id, state: LearningState): void =>
  writeJson(kernel, `learning-state:${botId}`, state)

/** Learning tools are listed only while the matching switch is on, so a bot without learning is unchanged. */
export const learningToolHidden = (kernel: Kernel, botId: Id, toolName: string): boolean => {
  if (!MEMORY_TOOLS.has(toolName) && !SKILL_TOOLS.has(toolName)) return false
  const settings = readLearning(kernel, botId)
  return MEMORY_TOOLS.has(toolName) ? !settings.memory : !settings.skills
}

/** A call made from the bot's learning conversation comes from an automatic review, not from the user's chat. */
export const markReviewThread = (kernel: Kernel, botId: Id, threadId: Id): void =>
  writeJson(kernel, `learning-review:${threadId}`, { botId })

export const isReviewThread = (kernel: Kernel, botId: Id, threadId: Id): boolean =>
  readLearningState(kernel, botId).reviewThreadId === threadId ||
  readJson(kernel, `learning-review:${threadId}`)?.botId === botId
