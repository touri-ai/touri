import type { ProviderEvent, RunErrorClass, RunUsage } from "@touri/contracts"
import { asRecord, classifyProviderError, numberValue, stringValue } from "../utils"

export type OpenCodePermission = {
  api: "legacy" | "v2"
  id: string
  permission: string
  patterns: string[]
  metadata: unknown
}

/** Translate both the stable part events and the newer session.next stream. */
export const openCodeEvents = (
  sessionID: string,
  emit: (event: ProviderEvent) => void,
  userMessageID?: string,
  mapError?: (detail: string) => { message: string; errorClass: RunErrorClass },
) => {
  const parts = new Map<string, { type: string; text: string }>()
  const seenSteps = new Set<string>()
  const userMessages = new Set<string>(userMessageID ? [userMessageID] : [])
  let flavor: "stable" | "next" | undefined
  const tools = new Map<string, string>()
  const usage: Partial<RunUsage> = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 }
  return (
    value: unknown,
  ): {
    idle?: boolean
    error?: string
    errorCode?: import("@touri/contracts").RunErrorClass
    permission?: OpenCodePermission
  } => {
    const event = asRecord(value)
    const props = asRecord(event?.properties)
    if (!props || typeof event?.type !== "string") throw new Error("Evento SSE do OpenCode inválido")
    const part = asRecord(props.part)
    if ((props.sessionID ?? part?.sessionID ?? asRecord(props.info)?.sessionID) !== sessionID) return {}
    const type = event.type
    if (type === "message.updated") {
      const info = asRecord(props.info)
      if (info?.role === "user" && typeof info.id === "string") userMessages.add(info.id)
    }
    if (userMessages.has(String(props.messageID ?? part?.messageID ?? ""))) return {}
    if (type === "session.idle" || (type === "session.status" && asRecord(props.status)?.type === "idle"))
      return { idle: true }
    if (type === "session.error" || type === "session.next.step.failed") {
      const error = props.error ?? props
      const mapped = mapError?.(JSON.stringify(error))
      const detail = mapped?.message ?? JSON.stringify(error)
      const name = asRecord(error)?.name ?? asRecord(error)?._tag
      const code = mapped
        ? mapped.errorClass
        : name === "ProviderAuthError"
          ? "cli_auth"
          : name === "ContextOverflowError"
            ? "context_overflow"
            : classifyProviderError(detail)
      emit({ type: "turn_completed", status: "failed", errorClass: code, errorMessage: detail })
      return { error: detail, errorCode: code }
    }
    if (type === "permission.asked" || type === "permission.v2.asked") {
      const action = props.permission ?? props.action
      const resources = props.patterns ?? props.resources
      if (typeof props.id !== "string" || typeof action !== "string") throw new Error("Pedido de permissão inválido")
      return {
        permission: {
          api: type === "permission.v2.asked" ? "v2" : "legacy",
          id: props.id,
          permission: action,
          patterns: Array.isArray(resources) ? resources.filter((p): p is string => typeof p === "string") : [],
          metadata: props.metadata,
        },
      }
    }
    if (type === "message.part.delta") {
      if (flavor === "next") return {}
      flavor = "stable"
      const id = stringValue(props.partID) ?? "part"
      const previous = parts.get(id)
      if (props.field === "text" && typeof props.delta === "string") {
        parts.set(id, { type: previous?.type ?? "text", text: (previous?.text ?? "") + props.delta })
        emit({
          type: previous?.type === "reasoning" ? "reasoning_delta" : "text_delta",
          itemId: id,
          delta: props.delta,
        })
      }
    }
    if (type === "message.part.updated" && part) {
      const id = stringValue(part.id) ?? "part"
      if (part.type === "text" || part.type === "reasoning") {
        // User/system parts must never be echoed as assistant output.
        if (part.synthetic === true || part.ignored === true) return {}
        const text = stringValue(part.text) ?? ""
        const previous = parts.get(id)?.text ?? ""
        parts.set(id, { type: part.type, text })
        if (text.startsWith(previous) && text.length > previous.length)
          emit({
            type: part.type === "text" ? "text_delta" : "reasoning_delta",
            itemId: id,
            delta: text.slice(previous.length),
          })
      }
      if (part.type === "tool") {
        const state = asRecord(part.state) ?? {}
        const tool = stringValue(part.tool) ?? "ferramenta"
        emit({
          type: "item",
          part: {
            type: "tool_call",
            callId: stringValue(part.callID) ?? id,
            tool,
            summary: `OpenCode · ${{ bash: "Executar comando", read: "Ler arquivo", edit: "Editar arquivo", write: "Criar arquivo", glob: "Buscar arquivos", grep: "Buscar texto", webfetch: "Consultar página" }[tool] ?? `Usar ${tool}`}`,
            inputJson: JSON.stringify(state.input ?? {}),
            outputJson:
              state.output === undefined && state.error === undefined
                ? null
                : JSON.stringify(state.output ?? state.error),
            ok: state.status === "completed" ? true : state.status === "error" ? false : null,
          },
        })
      }
    }
    if (type === "session.next.text.delta" || type === "session.next.reasoning.delta") {
      if (flavor === "stable") return {}
      flavor = "next"
      const id = stringValue(props.textID) ?? stringValue(props.reasoningID) ?? "part"
      const text = stringValue(props.delta) ?? ""
      const previous = parts.get(id)
      parts.set(id, { type: type.includes("reasoning") ? "reasoning" : "text", text: (previous?.text ?? "") + text })
      emit({ type: type.includes("reasoning") ? "reasoning_delta" : "text_delta", itemId: id, delta: text })
    }
    if (["session.next.tool.called", "session.next.tool.success", "session.next.tool.failed"].includes(type)) {
      const callId = stringValue(props.callID) ?? "tool"
      const tool = stringValue(props.tool) ?? tools.get(callId) ?? "ferramenta"
      tools.set(callId, tool)
      emit({
        type: "item",
        part: {
          type: "tool_call",
          callId,
          tool,
          summary: `OpenCode · Usar ${tool}`,
          inputJson: JSON.stringify(props.input ?? {}),
          outputJson: type.endsWith("called")
            ? null
            : JSON.stringify(props.result ?? props.error ?? props.content ?? {}),
          ok: type.endsWith("success") ? true : type.endsWith("failed") ? false : null,
        },
      })
    }
    const step = part?.type === "step-finish" ? part : type === "session.next.step.ended" ? props : null
    if (step && (type === "session.next.step.ended" ? flavor !== "stable" : flavor !== "next")) {
      const id = stringValue(step.id) ?? stringValue(event.id) ?? JSON.stringify(step)
      if (!seenSteps.has(id)) {
        seenSteps.add(id)
        const tokens = asRecord(step.tokens)
        usage.inputTokens = (usage.inputTokens ?? 0) + (numberValue(tokens?.input) ?? 0)
        usage.outputTokens =
          (usage.outputTokens ?? 0) + (numberValue(tokens?.output) ?? 0) + (numberValue(tokens?.reasoning) ?? 0)
        usage.cachedInputTokens = (usage.cachedInputTokens ?? 0) + (numberValue(asRecord(tokens?.cache)?.read) ?? 0)
        usage.costUsd = (usage.costUsd ?? 0) + (numberValue(step.cost) ?? 0)
        emit({
          type: "usage",
          usage: { ...usage },
          contextTokens: numberValue(tokens?.total) ?? numberValue(tokens?.input),
          contextWindow: null,
        })
      }
    }
    return {}
  }
}

/** SSE framing tolerates CRLF, comments, multiple data lines and chunk splits. */
export const readOpenCodeSse = async (
  stream: ReadableStream<Uint8Array>,
  onEvent: (value: unknown) => void,
): Promise<void> => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      const next = await reader.read()
      buffer += decoder.decode(next.value, { stream: !next.done }).replace(/\r/g, "")
      let end = buffer.indexOf("\n\n")
      while (end >= 0) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (data) onEvent(JSON.parse(data))
        end = buffer.indexOf("\n\n")
      }
      if (buffer.length > 4_000_000) throw new Error("Evento SSE do OpenCode excedeu o limite")
      if (next.done) {
        if (buffer.trim()) throw new Error("Evento SSE do OpenCode incompleto")
        return
      }
    }
  } finally {
    reader.releaseLock()
  }
}
