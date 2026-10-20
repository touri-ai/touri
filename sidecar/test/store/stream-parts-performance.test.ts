import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import type { MessagePart } from "@touri/contracts"
import { createStreamPartWriter } from "../../src/store/stream-parts"
import { getMaximum, getMedian, getPercentile, measureCpuTime } from "../fakes/latency"

const databases = new Set<Database>()
const timers = new Set<ReturnType<typeof setInterval>>()
afterEach(() => {
  timers.forEach(clearInterval)
  timers.clear()
  databases.forEach((database) => {
    database.close()
  })
  databases.clear()
})

test("stream preparation preserves complete plans for shuffled updates and duplicate indices", () => {
  const initial = Array.from({ length: 160 }, (_, index) => getPart(index, "initial"))
  const write = createStreamPartWriter(getDatabase(), "/synthetic", initial)
  const patches = Array.from({ length: 160 }, (_, index) => {
    const partIndex = (index * 79) % 160

    return { partIndex, part: getPart(partIndex, "updated") }
  }).concat({ partIndex: 7, part: getPart(7, "latest") })

  const first = write(patches)
  // Apply the returned patches to the local projection before its next preparation.
  first.parts.forEach(({ partIndex, part }) => {
    initial[partIndex] = part
  })
  const second = write([{ partIndex: 3, part: getPart(3, "finished") }])
  const digest = createHash("sha256")
    .update(JSON.stringify([first, second]))
    .digest("hex")

  expect(first.parts.map(({ partIndex }) => partIndex)).toEqual(patches.map(({ partIndex }) => partIndex))
  expect(digest).toBe("3e0f2bfc8ecb7f28dbdf9d5a5fcd7d5e61bdb2d85601bd67238bab0e5fee39ed")
})

test("ordering preserves unsigned array indices across every radix byte without mutating input", () => {
  const indices = [0, 255, 256, 65_535, 65_536, 16_777_215, 16_777_216, 2_147_483_647, 2_147_483_648, 4_294_967_294]
  const reversed = indices.map((_, index) => indices[indices.length - 1 - index] ?? 0)
  const patches = reversed.map((partIndex) => ({
    partIndex,
    part: getTool(partIndex, String(partIndex).padEnd(8_192, "x")),
  }))
  const before = JSON.stringify(patches)
  const write = createStreamPartWriter(getDatabase(), "/synthetic", [])

  const prepared = write(patches)

  expect(JSON.stringify(patches)).toBe(before)
  expect(prepared.parts.map(({ partIndex }) => partIndex)).toEqual(reversed)
  expect(prepared.parts.filter(({ part }) => "outputAttachmentId" in part).map(({ partIndex }) => partIndex)).toEqual([
    4_294_967_294, 2_147_483_648,
  ])
})

test.each([1_024, 10_240])("ordering %i shuffled parts uses a linear number of index reads", (count) => {
  const write = createStreamPartWriter(getDatabase(), "/synthetic", [])
  let indexReads = 0
  const patches = Array.from({ length: count }, (_, index) => {
    const partIndex = (index * 7_919) % count

    return {
      get partIndex() {
        indexReads += 1
        return partIndex
      },
      part: getTool(partIndex, "x"),
    }
  })

  const prepared = write(patches)

  expect(prepared.parts).toHaveLength(count)
  expect(indexReads).toBeLessThan(count * 20)
  console.info(`stream-parts-index-reads ${JSON.stringify({ count, indexReads })}`)
})

test("one and ten MiB replies preserve output and stay below 50 ms in provider-sized batches", async () => {
  const small = await getSamples(1_024 * 1_024)
  const large = await getSamples(10 * 1_024 * 1_024)

  const samples = small.concat(large)
  const timerLags = samples.flatMap(({ timerLagSamples }) => timerLagSamples)
  const preparationTimes = samples.flatMap(({ preparationCpuSamples }) => preparationCpuSamples)

  samples.forEach((sample) => {
    expect(sample.timerSamples).toBeGreaterThan(0)
  })
  expect(timerLags.length).toBeGreaterThan(10)
  expect(getPercentile(timerLags, 0.99)).toBeLessThan(50)
  expect(getMaximum(timerLags)).toBeLessThan(150)
  expect(getPercentile(preparationTimes, 0.99)).toBeLessThan(50)
  expect(getMaximum(preparationTimes)).toBeLessThan(150)
  small.forEach(({ digest }) => {
    expect(digest).toBe("42659b3790894e3cb8b064f27e67467db314a54cf29aa288f26e7ccf42ee0c52")
  })
  large.forEach(({ digest }) => {
    expect(digest).toBe("361b47799a1893821f96c3044846a9cbce250d02342e0be1352d380b4bae82de")
  })
  expect(getMedian(large.map(({ preparationCpuMs }) => preparationCpuMs))).toBeLessThan(
    getMedian(small.map(({ preparationCpuMs }) => preparationCpuMs)) * 15,
  )
  console.info(`stream-parts-benchmark ${JSON.stringify({ runtime: Bun.version, small, large })}`)
})

const getSamples = async (outputBytes: number) => {
  const samples = []
  for (const _sample of [0, 1, 2]) samples.push(await getSample(outputBytes))

  return samples
}

const getSample = async (outputBytes: number) => {
  const count = 836
  const initial: MessagePart[] = []
  const write = createStreamPartWriter(getDatabase(), "/synthetic", initial)
  const patches = Array.from({ length: count }, (_, partIndex) => {
    const bytes = Math.floor(outputBytes / count) + (partIndex < outputBytes % count ? 1 : 0)

    return { partIndex, part: getTool(partIndex, String(partIndex).padEnd(bytes, "x")) }
  })
  const files = new Map<string, { content: string; bytes: number }>()
  let preparationCpuMs = 0
  const preparationCpuSamples: Array<number> = []
  const timerLagSamples: Array<number> = []
  let timerSamples = 0
  let expectedAt = performance.now() + 1
  const timer = setInterval(() => {
    if (timerLagSamples.length < 10_000) timerLagSamples.push(Math.max(0, performance.now() - expectedAt))
    expectedAt = performance.now() + 1
    timerSamples += 1
  }, 1)
  timers.add(timer)
  await Bun.sleep(5)

  // The provider reader yields after at most 16 frames; replay the same bounded preparation batches.
  for (const start of Array.from({ length: Math.ceil(count / 16) }, (_, index) => index * 16)) {
    const batch = patches.slice(start, start + 16)
    const measured = measureCpuTime(() => write(batch))
    const prepared = measured.value
    preparationCpuMs += measured.cpuMs
    preparationCpuSamples.push(measured.cpuMs)
    // This local projection mirrors the stream writer applying each accepted batch.
    prepared.parts.forEach(({ partIndex, part }) => {
      initial[partIndex] = part
    })
    prepared.files.forEach(({ id, content, bytes }) => {
      files.set(id, { content, bytes })
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  await Bun.sleep(5)
  clearInterval(timer)
  const inlineBytes = initial.reduce(
    (total, part) => total + (part.type === "tool_call" ? Buffer.byteLength(part.outputJson ?? "") : 0),
    0,
  )
  const digest = createHash("sha256")
    .update(JSON.stringify({ parts: initial, files: Array.from(files) }))
    .digest("hex")

  expect(initial).toHaveLength(count)
  expect(Array.from(files.values()).reduce((total, file) => total + file.bytes, inlineBytes)).toBe(outputBytes)

  return { outputBytes, preparationCpuMs, preparationCpuSamples, timerLagSamples, timerSamples, digest }
}

const getDatabase = () => {
  const database = new Database(":memory:")
  database.exec("CREATE TABLE attachments (id TEXT PRIMARY KEY, path TEXT)")
  databases.add(database)

  return database
}

const getPart = (index: number, phase: string): MessagePart => {
  const output = `${phase}-${index}: ação 🙂\n`.repeat(index % 11 === 0 ? 800 : 7)
  if (index % 5 === 0)
    return {
      type: "command",
      callId: `command-${index}`,
      command: "sample",
      cwd: "/synthetic",
      outputTail: output,
      exitCode: 0,
    }
  if (index % 5 === 1) return { type: "file_change", callId: `file-${index}`, paths: ["sample.txt"], diff: output }
  if (index % 5 === 2) return { type: "text", text: output }
  if (index % 5 === 3) return { ...getTool(index, output), ok: null, resolution: "running" }

  return getTool(index, output)
}

const getTool = (index: number, outputJson: string): Extract<MessagePart, { type: "tool_call" }> => ({
  type: "tool_call",
  callId: `tool-${index}`,
  tool: "synthetic",
  summary: "Synthetic result",
  inputJson: "{}",
  outputJson,
  ok: true,
})
