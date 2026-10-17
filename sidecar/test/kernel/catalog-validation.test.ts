import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import catalog from "../../../packages/contracts/mcp-tools.json"
import { validateCatalog } from "../../../packages/contracts/src/validate-catalog"

test("the catalog compiles with shared definitions without changing its data", () => {
  const data = structuredClone(catalog)
  expect(() => validateCatalog(data)).not.toThrow()
  expect(data).toEqual(catalog)
})

test.each([
  ["null", null],
  ["non-array tools", { ...catalog, tools: "invalid" }],
  ["empty tools", { ...catalog, tools: [] }],
])("rejects a malformed catalog envelope: %s", (_name, data) => {
  expect(() => validateCatalog(data)).toThrow("Invalid MCP catalog")
})

test.each(["name", "description", "inputSchema", "x-touri"])("rejects a tool missing %s", (field) => {
  const tool: Record<string, unknown> = { ...catalog.tools[0] }
  delete tool[field]
  expect(() => validateCatalog({ ...catalog, tools: [tool] })).toThrow("Invalid MCP catalog")
})

test("rejects an inputSchema that is not an object schema", () => {
  const inputSchema = { type: "NOT_A_JSON_SCHEMA_TYPE" }
  expect(() => validateCatalog({ ...catalog, tools: [{ ...catalog.tools[0], inputSchema }] })).toThrow(
    "Invalid MCP catalog",
  )
})

test.each([
  { type: "object", properties: { query: { type: "NOT_A_JSON_SCHEMA_TYPE" } } },
  { type: "object", properties: { query: { $ref: "#/definitions/missing" } } },
  { type: "object", propertiez: { query: { type: "string" } } },
])("rejects an invalid tool inputSchema: %j", (inputSchema) => {
  expect(() => validateCatalog({ ...catalog, tools: [{ ...catalog.tools[0], inputSchema }] })).toThrow(
    "Invalid inputSchema for history_search",
  )
})

test("rejects invalid shared definitions", () => {
  expect(() => validateCatalog({ ...catalog, definitions: { target: { type: "INVALID" } } })).toThrow(
    "Invalid MCP catalog",
  )
})

test("rejects duplicate tool names instead of silently replacing a validator", () => {
  expect(() => validateCatalog({ ...catalog, tools: [catalog.tools[0], catalog.tools[0]] })).toThrow(
    "Duplicate MCP tool",
  )
})

test("the CI validation command accepts the real catalog and exits nonzero for malformed copies", () => {
  const root = new URL("../../../", import.meta.url)
  const workflow = readFileSync(new URL(".github/workflows/ci.yml", root), "utf8")
  expect(workflow).toContain("- run: bun packages/contracts/src/validate-catalog.ts")
  const script = new URL("packages/contracts/src/validate-catalog.ts", root).pathname
  const run = (path?: string) => Bun.spawnSync([process.execPath, script, ...(path ? [path] : [])])
  const valid = run()
  expect(valid.exitCode).toBe(0)
  expect(valid.stdout.toString()).toContain("MCP catalog is valid")

  const dir = mkdtempSync(join(tmpdir(), "touri-catalog-"))
  try {
    const path = join(dir, "invalid.json")
    for (const data of [
      null,
      { ...catalog, tools: "invalid" },
      { ...catalog, tools: [{ ...catalog.tools[0], inputSchema: { type: "INVALID" } }] },
      {
        ...catalog,
        tools: [{ ...catalog.tools[0], inputSchema: { type: "object", properties: { x: { type: "INVALID" } } } }],
      },
    ]) {
      writeFileSync(path, JSON.stringify(data))
      const invalid = run(path)
      expect(invalid.exitCode).toBe(1)
      expect(invalid.stderr.toString()).toContain("Invalid")
      expect(invalid.stdout.toString()).not.toContain("MCP catalog is valid")
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
