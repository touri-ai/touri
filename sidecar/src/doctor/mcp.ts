import type { Database } from "bun:sqlite"
import { join } from "node:path"
import type { AppPaths } from "@touri/contracts"
import { resolveMcpSocketPath } from "../kernel/paths"
import { listLiveShims } from "../mcp/shim-registry"
import { isMcpStartupError, MCP_STARTUP_MESSAGE } from "../runtime/mcp-startup"
import { check } from "./check"

export const mcpSocketPathCheck = (paths: AppPaths) => {
  const fallback = resolveMcpSocketPath(paths) !== join(paths.runDir, "mcp.sock")
  return check(
    "mcp-socket-path",
    "Ferramentas do touri · conexão local",
    "pass",
    fallback
      ? "O caminho dos dados é longo; a conexão local usa uma pasta temporária privada com caminho curto. Nenhuma ação necessária."
      : "A conexão local usa a pasta de execução do aplicativo.",
  )
}

export const mcpStartupChecks = (db: Database) => {
  // Keep a failure visible until that bot completes a successful turn, even
  // across app restarts. These checks report observed CLI health without waking VMs.
  const rows = db
    .query(`SELECT b.id, b.name, r.status, r.error_message FROM bots b
    LEFT JOIN runs r ON r.id = (SELECT id FROM runs WHERE bot_id = b.id
      AND (status = 'succeeded' OR error_message LIKE ?) ORDER BY queued_at DESC, rowid DESC LIMIT 1)
    WHERE b.machine = 'vm' AND b.archived_at IS NULL`)
    .all(`${MCP_STARTUP_MESSAGE}%`) as Array<{
    id: string
    name: string
    status: string | null
    error_message: string | null
  }>
  return rows.map((row) =>
    check(
      `vm-mcp:${row.id}`,
      `Ferramentas do touri · ${row.name}`,
      isMcpStartupError(row.error_message) ? "fail" : row.status === "succeeded" ? "pass" : "warn",
      isMcpStartupError(row.error_message)
        ? `${MCP_STARTUP_MESSAGE}. Tente novamente; se persistir, pare e inicie a máquina nas permissões do bot.`
        : row.status === "succeeded"
          ? "O último turno verificado concluiu sem falha de inicialização do MCP."
          : "Ainda não há um turno concluído para verificar o carregamento das ferramentas nesta máquina.",
    ),
  )
}

const ORPHAN_PARENT_PID = 1

export const orphanShimCheck = (runDir: string) => {
  const orphans = listLiveShims(runDir).filter((shim) => shim.ppid === ORPHAN_PARENT_PID)
  if (orphans.length === 0)
    return check("mcp-orphan-shims", "Ferramentas do touri · processos órfãos", "pass", "Nenhum processo MCP órfão.")
  return check(
    "mcp-orphan-shims",
    "Ferramentas do touri · processos órfãos",
    "warn",
    `${orphans.length} processo(s) MCP órfão(s): PID ${orphans.map((shim) => shim.record.pid).join(", ")}.`,
    "Reinicie o touri; os processos órfãos são encerrados na inicialização.",
  )
}
