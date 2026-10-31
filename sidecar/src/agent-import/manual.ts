import { normalizeBotName } from "@touri/contracts"
import { parseCron } from "@touri/contracts/routine-cron"
import { IMPORT_LIMITS, type ImportAgent, type ImportRoutine, type ImportSnapshot } from "./model"
import { hasSecret, isSafeText } from "./safety"

export const getManualSnapshot = (payload: unknown): ImportSnapshot => {
  const encoded = typeof payload === "string" ? payload : JSON.stringify(payload)
  if (!encoded || Buffer.byteLength(encoded) > IMPORT_LIMITS.total) throw new Error("INVALID_ARGS")
  const parsed = getParsedPayload(encoded)
  const root = getRecord(parsed, ["agents"])
  const agents = getArray(root.agents, IMPORT_LIMITS.agents).map(getManualAgent)
  if (!agents.length) throw new Error("INVALID_ARGS")

  return getSanitizedSnapshot(agents)
}

export const getRecord = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_ARGS")
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !keys.includes(key))) throw new Error("INVALID_ARGS")

  return record
}

export const getText = (value: unknown, limit = IMPORT_LIMITS.file): string => {
  if (typeof value !== "string" || Buffer.byteLength(value) > limit || value.includes("\0"))
    throw new Error("INVALID_ARGS")

  return value
}

const getArray = (value: unknown, limit = 100): unknown[] => {
  if (!Array.isArray(value) || value.length > limit) throw new Error("INVALID_ARGS")

  return value
}

export const getRoutine = (value: unknown): ImportRoutine => {
  const record = getRecord(value, ["name", "schedule", "prompt"])
  const schedule = getText(record.schedule, 100)
  if (!parseCron(schedule).success) throw new Error("INVALID_ARGS")

  const name = normalizeBotName(record.name)
  const prompt = getText(record.prompt, 8000)
  if (!name || name.length > 80 || !prompt.trim()) throw new Error("INVALID_ARGS")

  return { name, schedule, prompt }
}

const getManualAgent = (value: unknown, index: number): ImportAgent => {
  const record = getRecord(value, [
    "name",
    "personality",
    "instructions",
    "skills",
    "memories",
    "routines",
    "integrations",
  ])
  const name = normalizeBotName(record.name)
  if (!name) throw new Error("INVALID_ARGS")
  const role = getText(record.personality, 240)
  const skills = getArray(record.skills).map((value) => {
    const skill = getRecord(value, ["name", "content"])
    const name = getText(skill.name, 64)
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error("INVALID_ARGS")

    return { name, files: [{ path: "SKILL.md", content: getText(skill.content) }] }
  })
  if (new Set(skills.map(({ name }) => name)).size !== skills.length) throw new Error("INVALID_ARGS")

  return {
    key: `agent-${index + 1}`,
    name,
    ...(role ? { role } : {}),
    instructions: [getText(record.instructions)].filter(Boolean),
    skills,
    memories: getArray(record.memories).map((value) => getText(value)),
    routines: getArray(record.routines).map(getRoutine),
    integrations: getArray(record.integrations).map((value) => getText(value, 80)),
  }
}

const getSanitizedSnapshot = (agents: ImportAgent[]): ImportSnapshot => {
  // Counters are local to this validation pass and never retain rejected values.
  let secrets = 0
  let files = 0
  const accept = (text: string): boolean => {
    if (hasSecret(text)) {
      secrets += 1
      return false
    }
    if (!isSafeText(text)) {
      files += 1
      return false
    }
    return true
  }
  const sanitized = agents
    .filter((agent) => accept(`${agent.name}\n${agent.role ?? ""}`))
    .map((agent) => ({
      ...agent,
      instructions: agent.instructions.filter(accept),
      skills: agent.skills.filter((skill) =>
        accept(`${skill.name}\n${skill.files.map(({ content }) => content).join("\n")}`),
      ),
      memories: agent.memories.filter(accept),
      routines: agent.routines.filter((routine) => accept(`${routine.name}\n${routine.prompt}`)),
      integrations: agent.integrations.filter((name) => /^[\p{L}\p{N} _.-]{1,80}$/u.test(name) && accept(name)),
    }))

  return { source: "manual", agents: sanitized, excluded: { secrets, files } }
}

const getParsedPayload = (encoded: string): unknown => {
  try {
    return JSON.parse(encoded)
  } catch {
    throw new Error("INVALID_ARGS")
  }
}
