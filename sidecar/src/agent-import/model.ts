import type { AgentImportAgent, AgentImportSourceKind } from "@touri/contracts"

export const IMPORT_LIMITS = { file: 64 * 1024, total: 1024 * 1024, entries: 2000, agents: 20, depth: 6 } as const
export const PREVIEW_TTL_MS = 10 * 60 * 1000
export type ImportSkill = { name: string; files: { path: string; content: string }[] }
export type ImportRoutine = { name: string; schedule: string; prompt: string }
export type ImportAgent = {
  key: string
  name: string
  role?: string
  instructions: string[]
  skills: ImportSkill[]
  memories: string[]
  routines: ImportRoutine[]
  integrations: string[]
}
export type ImportSnapshot = {
  source: AgentImportSourceKind
  agents: ImportAgent[]
  excluded: { secrets: number; files: number }
}

export const getAgentPreview = (agent: ImportAgent): AgentImportAgent => ({
  key: agent.key,
  name: agent.name,
  suggestedBotName: agent.name,
  ...(agent.role ? { role: agent.role } : {}),
  instructions: {
    files: agent.instructions.length,
    bytes: agent.instructions.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
  },
  skills: agent.skills.map((skill) => ({
    name: skill.name,
    bytes: skill.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0),
  })),
  memories: agent.memories.length,
  routines: agent.routines.map(({ name, schedule }) => ({ name, schedule })),
  integrations: agent.integrations,
})

export type ImportFileRead =
  | { kind: "file"; content: string; bytes: number }
  | { kind: "secret"; bytes: number }
  | { kind: "excluded"; bytes: number }
