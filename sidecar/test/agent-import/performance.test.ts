import { expect, test } from "bun:test"
import { join } from "node:path"
import { hasSecret, isSafeText } from "../../src/agent-import/safety"
import { getFolderSnapshot } from "../../src/agent-import/scan"
import { getMaximum, getPercentile, startEventLoopLagProbe } from "../fakes/latency"
import { makeHarness } from "./harness"

test("long delimiter-free text is scanned with bounded synchronous work", () => {
  const text = "a".repeat(64 * 1024)
  const started = performance.now()

  expect(hasSecret(text)).toBe(false)
  expect(isSafeText(text)).toBe(true)
  expect(isSafeText(`<${text}`)).toBe(true)

  expect(performance.now() - started).toBeLessThan(50)
})

test("a bounded folder import yields to timer and request work", async () => {
  const fixture = await makeHarness()
  for (const index of Array.from({ length: 100 }, (_, index) => index)) {
    await fixture.write(`export/notes-${index}.md`, "Notas de contexto. ".repeat(300))
  }
  const probe = startEventLoopLagProbe(5)
  const started = performance.now()
  const snapshot = await getFolderSnapshot({
    path: join(fixture.home, "export"),
    source: "folder",
    appData: fixture.appData,
    signal: new AbortController().signal,
  })
  probe.stop()
  const samples = probe.getSamples()
  const p99 = getPercentile(samples, 0.99)
  const maximum = getMaximum(samples)
  console.info(
    JSON.stringify({
      measurement: "agent-import",
      files: 100,
      bytes: 570000,
      intervalMs: 5,
      samples: samples.length,
      durationMs: performance.now() - started,
      p99Ms: p99,
      maxMs: maximum,
    }),
  )

  expect(snapshot.agents[0]?.instructions).toHaveLength(100)
  expect(samples.length).toBeGreaterThan(0)
  expect(p99).toBeLessThan(50)
})
