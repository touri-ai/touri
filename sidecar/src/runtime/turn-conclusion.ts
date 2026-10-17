import type { MessagePart } from "@touri/contracts"
import { asRecord } from "./utils"

type ToolPart = Extract<MessagePart, { callId: string }>

const resultOf = (part: ToolPart): boolean | null => {
  if (part.type === "tool_call") return part.ok
  if (part.type === "command") return part.exitCode === null ? null : part.exitCode === 0
  if (part.resolution === "completed_unobserved")
    return part.completedOutcome === undefined ? null : part.completedOutcome === "succeeded"
  return part.resolution === "succeeded" || part.resolution === undefined
    ? true
    : part.resolution === "failed"
      ? false
      : null
}

const changedPaths = (part: ToolPart): string[] => {
  if (resultOf(part) !== true) return []
  if (part.type === "file_change") return part.paths
  // Only native file tools have known write semantics; shell text and arbitrary MCP inputs do not.
  if (part.type !== "tool_call" || !/^(write|edit|multiedit)$/i.test(part.tool)) return []
  try {
    const input = asRecord(JSON.parse(part.inputJson))
    const path = input?.file_path ?? input?.filePath
    return typeof path === "string" ? [path] : []
  } catch {
    return []
  }
}

const englishRequest = (request: string): boolean => {
  if (/\b(?:em ingl[eê]s|in english)\b/i.test(request)) return true
  if (/\b(?:em portugu[eê]s|in portuguese|pt-BR)\b/i.test(request)) return false
  const prose = request.replace(/`[^`]*`|\S*[./\\]\S*/g, "")
  return /\b(please|create|write|read|show|check|run|update|delete|make|find|list|build|search|summarize)\b/i.test(
    prose,
  )
}

/** Summarize observed outcomes only, never infer file writes from commands or requested paths. */
export const turnConclusion = ({
  parts,
  requestText,
}: {
  parts: MessagePart[]
  requestText: string
}): string | null => {
  let lastActivity = -1
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]
    if (part && ("callId" in part || part.type === "approval")) {
      lastActivity = index
      break
    }
  }
  if (lastActivity < 0 || parts.slice(lastActivity + 1).some((part) => part.type === "text" && part.text.trim()))
    return null
  const tools = parts.filter((part): part is ToolPart => "callId" in part)
  const denied = parts.some((part) => part.type === "approval" && part.decision === "denied")
  const unconfirmed = tools.some((part) => resultOf(part) === null)
  const failed = tools.some((part) => resultOf(part) === false)
  const en = englishRequest(requestText)
  const summary = denied
    ? en
      ? "An action was not authorized."
      : "Uma ação não foi autorizada."
    : failed
      ? en
        ? "Some actions failed."
        : "Não foi possível concluir todas as ações."
      : unconfirmed || !tools.length
        ? en
          ? "The turn ended, but the result of the actions could not be confirmed."
          : "A resposta terminou, mas não foi possível confirmar o resultado das ações."
        : en
          ? "Done."
          : "Concluído."
  const paths = [...new Set(tools.flatMap(changedPaths))].filter((path) => path.trim())
  if (!paths.length) return summary
  const shown = paths.slice(0, 5).map((path) => path.replace(/[\r\n\0]/g, " ").slice(0, 160))
  const more = paths.length > shown.length ? (en ? ", and other files" : ", e outros arquivos") : ""
  return `${summary} ${en ? "Files changed" : "Arquivos alterados"}: ${shown.join(", ")}${more}.`
}
