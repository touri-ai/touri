import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { SCHEMA_VERSION } from "../../src/kernel/db"

test("desktop and sidecar agree on the startup schema", () => {
  const desktop = readFileSync(new URL("../../../src-tauri/src/sidecar.rs", import.meta.url), "utf8")
  const version = desktop.match(/SIDECAR_SCHEMA_VERSION: u32 = (\d+);/)
  expect(Number(version?.[1])).toBe(SCHEMA_VERSION)
})
