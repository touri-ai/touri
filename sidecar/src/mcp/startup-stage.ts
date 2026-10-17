/** Where the touri MCP shim stopped before the first protocol reply reached the provider CLI. */
export type McpShimStage =
  | "parent_gone"
  | "stdin_closed"
  | "terminated"
  | "socket_error"
  | "token_unavailable"
  | "closed_before_initialize"
  | "handshake_timeout"
  | "bridge_closed"
  | "unknown"

const MCP_SHIM_STAGES: ReadonlyArray<McpShimStage> = [
  "parent_gone",
  "stdin_closed",
  "terminated",
  "socket_error",
  "token_unavailable",
  "closed_before_initialize",
  "handshake_timeout",
  "bridge_closed",
]

export const MCP_STARTUP_FAILURE_PREFIX = "touri MCP startup failed"

/** The one stderr line a shim writes when it stops before answering the CLI. */
export const mcpStartupFailureLine = ({ stage }: { stage: McpShimStage }): string =>
  `${MCP_STARTUP_FAILURE_PREFIX}: ${stage}`

/** Reads the stage out of provider diagnostics; a CLI timeout message maps to a handshake timeout. */
export const parseMcpShimStage = (text: string): McpShimStage => {
  const marker = text.match(/touri MCP startup failed: ([a-z_]+)/)
  const named = MCP_SHIM_STAGES.find((stage) => stage === marker?.[1])
  if (named) return named
  if (/Unable to read MCP token/i.test(text)) return "token_unavailable"
  if (/MCP socket error/i.test(text)) return "socket_error"
  if (/time(?:d)?[ -]?out|timeout/i.test(text)) return "handshake_timeout"
  if (/connection closed|initialize (?:response|closed)|transport closed/i.test(text)) return "closed_before_initialize"
  return "unknown"
}
