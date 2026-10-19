import { expect, test } from "bun:test"
import { fsyncSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { atomicDownload } from "../../src/vm/atomic-download"
import { createAtomicDownloadWriter } from "../../src/vm/atomic-download-core"

for (const failure of [0, 1, 2, 3])
  test(`B05 atomic download publishes only complete synced data; sync failure ${failure}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "touri-snapshot-"))
    try {
      const path = join(root, "snapshot")
      writeFileSync(path, "original")
      let calls = 0
      const writer = createAtomicDownloadWriter(path, {
        sync: (fd) => {
          calls++
          if (calls === failure) throw new Error("injected")
          fsyncSync(fd)
        },
      })
      writer.write(Buffer.from("complete"))
      if (failure) expect(() => writer.finish()).toThrow()
      else writer.finish()
      expect(readFileSync(path, "utf8")).toBe(failure ? "original" : "complete")
      expect(readdirSync(root)).toEqual(["snapshot"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
test("B05 snapshot download rejects linked destination and leaves its target intact", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-snapshot-link-"))
  try {
    writeFileSync(join(root, "original"), "original")
    symlinkSync(join(root, "original"), join(root, "snapshot"))
    await expect(atomicDownload(new Response("new"), join(root, "snapshot"))).rejects.toThrow()
    expect(readFileSync(join(root, "original"), "utf8")).toBe("original")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("B05 snapshot bytes are streamed through the worker before publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-snapshot-worker-"))
  try {
    const path = join(root, "snapshot")
    await atomicDownload(new Response("complete"), path)
    expect(readFileSync(path, "utf8")).toBe("complete")
    expect(readdirSync(root)).toEqual(["snapshot"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
