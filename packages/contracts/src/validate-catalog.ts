import Ajv, { type AnySchemaObject } from "ajv"

interface Catalog {
  definitions: Record<string, AnySchemaObject | boolean>
  tools: { name: string; inputSchema: AnySchemaObject }[]
}

// The catalog is data, not a JSON Schema. Check its envelope before compiling
// each tool with the same shared definitions used by the runtime validators.
const catalogSchema = {
  type: "object",
  required: ["version", "toolsetVersion", "definitions", "tools"],
  additionalProperties: false,
  properties: {
    $comment: { type: "string" },
    version: { type: "string", minLength: 1 },
    toolsetVersion: { type: "string", minLength: 1 },
    definitions: {
      type: "object",
      additionalProperties: { $ref: "http://json-schema.org/draft-07/schema#" },
    },
    tools: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["name", "description", "inputSchema", "x-touri"],
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1 },
          description: { type: "string", minLength: 1 },
          inputSchema: {
            type: "object",
            required: ["type"],
            properties: { type: { const: "object" } },
          },
          "x-touri": {
            type: "object",
            required: ["group", "mvp", "mutates"],
            additionalProperties: false,
            properties: {
              group: { type: "string", minLength: 1 },
              mvp: { type: "boolean" },
              mutates: { type: "boolean" },
              internal: { type: "boolean" },
              providers: { type: "array", items: { type: "string", minLength: 1 } },
              deadlineMs: { type: "integer", minimum: 1 },
            },
          },
        },
      },
    },
  },
}

export function validateCatalog(data: unknown): void {
  const ajv = new Ajv({ strict: true, allErrors: true })
  const validate = ajv.compile<Catalog>(catalogSchema)
  if (!validate(data)) throw new Error(`Invalid MCP catalog: ${ajv.errorsText(validate.errors)}`)

  const names = new Set<string>()
  for (const tool of data.tools) {
    if (names.has(tool.name)) throw new Error(`Duplicate MCP tool: ${tool.name}`)
    names.add(tool.name)
    try {
      ajv.compile({ ...tool.inputSchema, definitions: data.definitions })
    } catch (error) {
      throw new Error(`Invalid inputSchema for ${tool.name}: ${String(error)}`)
    }
  }
}

if (import.meta.main) {
  try {
    validateCatalog(await Bun.file(process.argv[2] ?? new URL("../mcp-tools.json", import.meta.url)).json())
    console.log("MCP catalog is valid")
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
