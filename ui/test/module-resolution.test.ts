import { readdirSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"

test("source modules resolve unambiguously on case-insensitive filesystems", () => {
  const root = join(import.meta.dirname, "../src")
  const modules = new Map<string, string>()
  const collisions: string[][] = []
  const visit = (directory: string) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (/\.tsx?$/.test(entry.name)) {
        const key = path.replace(/\.tsx?$/, "").toLowerCase()
        const previous = modules.get(key)
        if (previous) collisions.push([previous, path])
        modules.set(key, path)
      }
    }
  }

  visit("")
  expect(collisions).toEqual([])
})
