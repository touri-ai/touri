import type { ApprovalPart } from "@touri/contracts"
import { asRecord, stringValue } from "../runtime/utils"

const internalField =
  /^(?:id|(?:approval|thread|turn|item|call|toolUse|tool_use|request|session|run)_?id|(?:started|created|updated|resolved|completed)_?at(?:Ms|_ms)?)$/i

export const approvalPayload = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(approvalPayload)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !internalField.test(key))
        .map(([key, item]) => [key, approvalPayload(item)]),
    )
  return value
}

export const codexApprovalPayload = (
  params: Record<string, unknown>,
  item: Record<string, unknown> | undefined,
  cwd: string,
) => {
  const input = { ...params }
  for (const key of ["command", "commandLine", "cwd", "paths", "changes", "fileChanges", "diff"])
    if (input[key] == null && item?.[key] != null) input[key] = item[key]
  input.cwd = stringValue(input.cwd) || cwd
  if (!input.command && input.commandLine) input.command = input.commandLine
  return approvalPayload(input)
}

export const claudeApprovalKind = (tool: string): ApprovalPart["request"] =>
  /^(Bash|shell|terminal|exec_command)$/i.test(tool)
    ? "command"
    : /^(Write|Edit|MultiEdit|NotebookEdit)$/i.test(tool)
      ? "file_change"
      : "permission"

// Review context must never be returned as updatedInput to the provider.
export const claudeApprovalPayload = (input: unknown, cwd?: string, reason?: string | null) =>
  approvalPayload({
    ...(asRecord(input) ?? { input }),
    approvalContext: { ...(cwd ? { cwd } : {}), ...(reason ? { reason } : {}) },
  })
