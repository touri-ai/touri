import type { ToolKind } from "./toolPresentation"

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const text = (value: unknown): string => (typeof value === "string" ? value : "")
const paths = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter((path): path is string => typeof path === "string" && !!path)

const internalField =
  /^(?:id|(?:approval|thread|turn|item|call|toolUse|tool_use|request|session|run)_?id|(?:started|created|updated|resolved|completed)_?at(?:Ms|_ms)?)$/i

export const withoutApprovalMetadata = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutApprovalMetadata)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !internalField.test(key))
        .map(([key, item]) => [key, withoutApprovalMetadata(item)]),
    )
  return value
}

const approvalReason = (reason: string, provider: string): string => {
  if (
    /sandbox.*(?:failed to (?:start|initialize)|(?:startup|initialization) failed)|sandbox falhou ao iniciar/i.test(
      reason,
    )
  )
    return `O isolamento (sandbox) falhou ao iniciar. O ${provider} quer executar este comando sem isolamento.`
  if (/command failed;?\s*retry without sandbox\??/i.test(reason))
    return `O comando falhou. O ${provider} quer tentar novamente sem isolamento (sandbox).`
  if (/(?:retry|run|execute|rerun).*(?:outside|without).*(?:sandbox)/i.test(reason))
    return `O ${provider} pede para executar esta ação sem isolamento (sandbox).`
  return reason
}

const editPreview = (input: Record<string, unknown>): string => {
  if (typeof input.old_string !== "string" || typeof input.new_string !== "string") return ""
  return [
    ...input.old_string.split("\n").map((line) => `-${line}`),
    ...input.new_string.split("\n").map((line) => `+${line}`),
  ].join("\n")
}

export type ApprovalFile = { path: string; action: string; diff: string }

const fileChanges = (input: Record<string, unknown>, name: string): ApprovalFile[] => {
  const changeList = input.changes ?? input.fileChanges
  const changes = Array.isArray(changeList)
    ? changeList
    : Object.entries(record(changeList)).map(([path, change]) => ({ ...record(change), path }))
  const fallbackAction = /^read$/i.test(name) ? "Ler" : /^write$/i.test(name) ? "Criar ou substituir" : "Alterar"
  const files = changes.flatMap((value) => {
    const change = record(value)
    const path = text(change.path)
    if (!path) return []
    const kind = text(record(change.kind).type) || text(change.kind) || text(change.type)
    const action = /^(add|create)$/i.test(kind) ? "Criar" : /^(delete|remove)$/i.test(kind) ? "Excluir" : "Alterar"
    const destination = text(record(change.kind).move_path) || text(change.move_path)
    return [
      {
        path,
        action: destination ? `${action} e mover para ${destination}` : action,
        diff: text(change.diff) || text(change.unified_diff),
      },
    ]
  })
  const targetPaths = paths(input.file_path ?? input.filePath ?? input.path ?? input.paths)
  for (const path of targetPaths) {
    if (files.some((file) => file.path === path)) continue
    const edits = Array.isArray(input.edits) ? input.edits.map((edit) => editPreview(record(edit))).join("\n") : ""
    const content =
      typeof input.content === "string"
        ? input.content
            .split("\n")
            .map((line) => `+${line}`)
            .join("\n")
        : ""
    files.push({
      path,
      action: fallbackAction,
      diff: (targetPaths.length === 1 ? text(input.diff) : "") || editPreview(input) || edits || content,
    })
  }
  return files
}

export const compactApprovalDiff = (diff: string): string => {
  const lines = diff.split("\n")
  const preview = lines.slice(0, 12).join("\n").slice(0, 2000)
  return preview.length < diff.length
    ? `${preview}\n… Prévia reduzida; conteúdo completo nos detalhes técnicos.`
    : preview
}

export const approvalContent = (value: unknown, kind: ToolKind, name: string, provider: string) => {
  const input = record(value)
  const context = record(input.approvalContext)
  const permissions = record(input.additionalPermissions ?? input.permissions)
  const fileSystem = record(permissions.fileSystem ?? permissions.file_system ?? permissions.filesystem)
  const network = permissions.network ?? input.networkAccess ?? input.network_access
  const networkContext = record(input.networkApprovalContext)
  const networkEnabled = typeof network === "boolean" ? network : record(network).enabled
  const unknown = ""
  const access = (value: unknown): string =>
    Array.isArray(value) ? paths(value).join(", ") || "Nenhuma pasta solicitada" : unknown
  const files = kind === "files" ? fileChanges(input, name) : []
  const writeTargets = files.filter((file) => file.action !== "Ler").map((file) => file.path)
  const scope = [
    { label: "Pasta de trabalho", value: text(input.cwd) || text(context.cwd) || unknown },
    ...(text(input.grantRoot) ? [{ label: "Pasta autorizada para alterações", value: text(input.grantRoot) }] : []),
    {
      label: "Leitura",
      value:
        fileSystem.read === undefined && /^read$/i.test(name) && files.length
          ? files.map((file) => file.path).join(", ")
          : access(fileSystem.read),
    },
    {
      label: "Escrita",
      value:
        fileSystem.write === undefined
          ? text(input.grantRoot) || writeTargets.join(", ") || unknown
          : access(fileSystem.write),
    },
    {
      label: "Rede",
      value: text(networkContext.host)
        ? `Acesso a ${text(networkContext.host)}${text(networkContext.protocol) ? ` (${text(networkContext.protocol)})` : ""}`
        : networkEnabled === true
          ? "Permitida"
          : networkEnabled === false
            ? "Não solicitada"
            : unknown,
    },
  ]
  return {
    reason: approvalReason(text(context.reason) || text(input.reason) || text(input.justification), provider),
    scope,
    files,
    diff: kind === "files" && !files.some((file) => file.diff) ? text(input.diff) : "",
    missingFiles:
      kind === "files" && !files.length
        ? `O ${provider} não informou quais arquivos serão ${/^read$/i.test(name) ? "consultados" : "alterados"}.`
        : "",
  }
}
