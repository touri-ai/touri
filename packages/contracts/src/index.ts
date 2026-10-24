import Ajv, { type JSONSchemaType, type ValidateFunction } from "ajv"
import catalog from "../mcp-tools.json"
import type { Result } from "./types"

export * from "./api-models"
export * from "./avatar"
export * from "./bot-name"
export * from "./cloud"
export * from "./errors"
export * from "./group-validation"
export * from "./host"
export * from "./notification-body"
export * from "./notification-preferences"
export * from "./notification-read"
export * from "./protocol"
export * from "./reports"
export * from "./routine-schedule"
export * from "./team-proposal"
export * from "./types"
export { catalog as toolCatalog }

type ToolDefinition = (typeof catalog)["tools"][number]

// Compiled lazily: Ajv generates code with new Function, which the desktop CSP forbids.
// Importing this module must never run it, or the whole UI fails to load.
let validators: Map<string, ValidateFunction<unknown>> | null = null

const toolValidators = (): Map<string, ValidateFunction<unknown>> => {
  if (validators) return validators
  const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true })
  const compiled = new Map<string, ValidateFunction<unknown>>()
  for (const tool of catalog.tools as readonly ToolDefinition[]) {
    const schema = { ...tool.inputSchema, definitions: catalog.definitions } as unknown as JSONSchemaType<unknown>
    compiled.set(tool.name, ajv.compile<unknown>(schema))
  }
  validators = compiled
  return compiled
}

const MIN_BROWSER_TIMEOUT_MS = 500
const MAX_BROWSER_TIMEOUT_MS = 30000
const MAX_TAKEOVER_TIMEOUT_MS = 1800000
const MIN_TAKEOVER_TIMEOUT_MS = 10000

const timeoutBounds = (name: string): { min: number; max: number } =>
  name === "browser_request_takeover"
    ? { min: MIN_TAKEOVER_TIMEOUT_MS, max: MAX_TAKEOVER_TIMEOUT_MS }
    : { min: MIN_BROWSER_TIMEOUT_MS, max: MAX_BROWSER_TIMEOUT_MS }

/**
 * Models often send timeoutMs as "30000", 120000 or 100. The intent is clear, so
 * a numeric value is rounded and clamped instead of failing the whole call.
 */
const normalizeBrowserTimeout = ({ name, args }: { name: string; args: unknown }): void => {
  if (!name.startsWith("browser_") || typeof args !== "object" || args === null) return
  const record = args as Record<string, unknown>
  const raw = record.timeoutMs
  const numeric = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw
  if (typeof numeric !== "number" || !Number.isFinite(numeric)) return
  const { min, max } = timeoutBounds(name)
  record.timeoutMs = Math.min(max, Math.max(min, Math.round(numeric)))
}

export const validateToolArgs = ({
  name,
  args,
}: {
  name: string
  args: unknown
}): Result<{ args: unknown }, "INVALID_ARGS"> => {
  normalizeBrowserTimeout({ name, args })
  const validator = toolValidators().get(name)
  if (!validator) {
    return { success: false, errorCode: "INVALID_ARGS", error: `Unknown tool ${name} (schema path: $)` }
  }

  if (validator(args)) {
    return { success: true, args }
  }

  const details = (validator.errors ?? [])
    .map(
      (error) => `${error.instancePath || "$"}: ${error.message ?? "invalid value"} (schema path: ${error.schemaPath})`,
    )
    .join("; ")
  const targetHint =
    name.startsWith("browser_") && validator.errors?.some((error) => error.instancePath.startsWith("/target"))
      ? "Alvo inválido. Use target: {kind: 'ref', ref: '4.43'} com o ref da captura, sempre entre aspas; ou selecione por role/name. "
      : ""
  return {
    success: false,
    errorCode: "INVALID_ARGS",
    error: targetHint + (details || "Invalid arguments (schema path: $)"),
  }
}
