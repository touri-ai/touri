import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import type { Kernel, ToolContext } from "@touri/contracts"
import { createComputerInput } from "../../src/computer/input-control"

const fixture = () => {
  const db = new Database(":memory:")
  const events: unknown[] = []
  const kernel = { db, publish: (event: unknown) => events.push(event) } as unknown as Kernel
  return { db, kernel, events, gate: createComputerInput(kernel) }
}
const ctx = (botId = "vm") => ({ botId, signal: new AbortController().signal }) as ToolContext
const ok = async () => ({ success: true as const, content: [] })

test("takeover waits for the current input, holds only that target and resumes queued input exactly once", async () => {
  const f = fixture()
  let finish: () => void = () => {}
  const steps: string[] = []
  const current = f.gate.run(ctx(), async () => {
    steps.push("completed step")
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return ok()
  })
  let taken = false
  const take = f.gate.take("vm", ctx().signal).then(() => {
    taken = true
  })
  const pending = f.gate.run(ctx(), async () => {
    steps.push("next step")
    return ok()
  })
  expect(taken).toBe(false)
  await f.gate.run(ctx("other"), async () => {
    steps.push("other target")
    return ok()
  })
  finish()
  await current
  await take
  expect(steps).toEqual(["completed step", "other target"])
  // A fresh service after a daemon restart still remembers the human's hold.
  expect(createComputerInput(f.kernel).human("vm")).toBe(true)
  f.gate.handBack("vm")
  await pending
  expect(steps).toEqual(["completed step", "other target", "next step"])
  expect(f.events).toEqual([
    { type: "desktop.control", botId: "vm", human: true },
    { type: "desktop.control", botId: "vm", human: false },
  ])
  f.db.close()
})

test("kill cancels in-flight input, rejects queued and new input until explicit handback", async () => {
  const f = fixture()
  let canceled = false
  const current = f.gate.run(ctx(), async (signal) => {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => {
        canceled = true
        resolve()
      }),
    )
    return ok()
  })
  const queued = f.gate.run(ctx(), () => {
    throw new Error("must not inject")
  })
  f.gate.kill()
  expect((await current).success).toBe(false)
  expect((await queued).success).toBe(false)
  expect(canceled).toBe(true)
  expect((await f.gate.run(ctx(), ok)).success).toBe(false)
  await f.gate.take("vm", ctx().signal)
  expect((await f.gate.run(ctx(), ok)).success).toBe(false)
  f.gate.handBack("vm")
  expect((await f.gate.run(ctx(), ok)).success).toBe(true)
  expect((await f.gate.run(ctx("other"), ok)).success).toBe(false)
  f.db.close()
})

test("canceling a pending action under human control never injects or releases the hold", async () => {
  const f = fixture()
  await f.gate.take("vm", ctx().signal)
  const abort = new AbortController()
  const pending = f.gate.run({ ...ctx(), signal: abort.signal }, () => {
    throw new Error("must not inject")
  })
  abort.abort()
  expect((await pending).success).toBe(false)
  expect(f.gate.human("vm")).toBe(true)
  f.db.close()
})
