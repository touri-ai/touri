import { afterEach, expect, mock, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { removeSmokeDirectory } from "../../../scripts/smoke-cleanup"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test.each(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"])(
  "smoke cleanup retries %s after yielding and removes the real fixture",
  async (code) => {
    const root = await mkdtemp(join(tmpdir(), "touri-smoke-cleanup-"))
    roots.push(root)
    const marker = join(root, "fixture.txt")
    await writeFile(marker, "synthetic smoke fixture")
    const failure = Object.assign(new Error("transient fixture lock"), { code })
    const remove = mock(async (path: string) => rm(path, { recursive: true, force: true }))
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
    const wait = mock(async (_milliseconds: number) => {
      expect(await readFile(marker, "utf8")).toBe("synthetic smoke fixture")
    })

    await removeSmokeDirectory(root, { remove, wait })

    expect(remove.mock.calls).toEqual([[root], [root], [root]])
    expect(wait.mock.calls).toEqual([[100], [200]])
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" })
  },
)

test("smoke cleanup propagates a persistent lock after its existing retry budget", async () => {
  const failure = Object.assign(new Error("persistent fixture lock"), { code: "EBUSY" })
  const remove = mock(async () => {
    throw failure
  })
  const wait = mock(async (_milliseconds: number) => {})

  await expect(removeSmokeDirectory("synthetic-root", { remove, wait })).rejects.toBe(failure)

  expect(remove).toHaveBeenCalledTimes(21)
  expect(wait.mock.calls).toEqual(Array.from({ length: 20 }, (_, index) => [(index + 1) * 100]))
})

test("smoke cleanup propagates non-transient failures without retrying", async () => {
  const failure = Object.assign(new Error("denied fixture removal"), { code: "EACCES" })
  const remove = mock(async () => {
    throw failure
  })
  const wait = mock(async (_milliseconds: number) => {})

  await expect(removeSmokeDirectory("synthetic-root", { remove, wait })).rejects.toBe(failure)

  expect(remove).toHaveBeenCalledTimes(1)
  expect(wait).not.toHaveBeenCalled()
})
