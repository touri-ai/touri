/** Agent import: bring agents from another local agent setup into touri. Preview writes nothing; apply copies, never moves. */
export type AgentImportSourceKind = "claude-code" | "folder" | "manual"
export type AgentImportSummary = { agents: number; skills: number; memories: number; routines: number; integrations: number }
export type AgentImportSource = {
  id: string
  kind: AgentImportSourceKind
  label: string
  found: boolean
  /** Host path shown to the owner; never sent to models. */
  path?: string
  summary?: AgentImportSummary
}
export type AgentImportItemSelection = { instructions: boolean; skills: boolean; memories: boolean; routines: boolean }
export type AgentImportAgent = {
  key: string
  name: string
  suggestedBotName: string
  role?: string
  instructions: { files: number; bytes: number }
  skills: { name: string; bytes: number }[]
  memories: number
  routines: { name: string; schedule: string }[]
  /** Names only. Secrets are never read into the preview. */
  integrations: string[]
}
export type AgentImportPreview = {
  previewId: string
  source: AgentImportSourceKind
  agents: AgentImportAgent[]
  excluded: { secrets: number; files: number }
  expiresAt: number
}
export type AgentImportProgress = {
  importId: string
  agentKey: string
  step: "instructions" | "skills" | "memories" | "routines" | "done" | "failed"
  done: number
  total: number
  message?: string
}
export type AgentImportResult = { importId: string; bots: { agentKey: string; botId: string }[]; pausedRoutines: number; reconnect: string[] }
export type AgentImportRoutes = {
  "GET /api/v1/import/sources": { req: {}; res: { sources: AgentImportSource[] } }
  "POST /api/v1/import/preview": {
    req: { source: AgentImportSourceKind; path?: string; payload?: unknown }
    res: AgentImportPreview
  }
  "POST /api/v1/import/apply": {
    req: { previewId: string; select: Record<string, AgentImportItemSelection> }
    res: AgentImportResult
  }
  "POST /api/v1/import/undo": { req: { importId: string }; res: { removedBots: number } }
}
