import { createWriteStream } from "node:fs"
import { readFile } from "node:fs/promises"
import type { CDPSession, Page } from "@playwright/test"

export const captureMemorySample = async (page: Page, cdp: CDPSession, started: number) => {
  await cdp.send("HeapProfiler.collectGarbage")
  const heap = await cdp.send("Runtime.getHeapUsage")
  const dom = await cdp.send("Memory.getDOMCounters")
  const resources = await page.evaluate(() => {
    const getFixture = Reflect.get(window, "getDesktopMemoryFixture") as
      | (() => { bots: number; messages: number; replies: number })
      | undefined
    const counters = Reflect.get(window, "desktopMemoryCounters") as {
      frames: Set<number>
      intervals: Set<number>
      wasmInstantiations: number
    }
    return {
      elements: document.querySelectorAll("*").length,
      images: document.images.length,
      decodedImageBytesEstimate: Array.from(document.images).reduce(
        (total, image) => total + image.naturalWidth * image.naturalHeight * 4,
        0,
      ),
      canvasBytesEstimate: Array.from(document.querySelectorAll("canvas")).reduce(
        (total, canvas) => total + canvas.width * canvas.height * 4,
        0,
      ),
      svg: document.querySelectorAll("svg").length,
      svgNodes: Array.from(document.querySelectorAll("svg")).reduce(
        (total, svg) => total + svg.querySelectorAll("*").length,
        0,
      ),
      raf: counters.frames.size,
      intervals: counters.intervals.size,
      cssAnimations: document.getAnimations().length,
      wasmInstantiations: counters.wasmInstantiations,
      fixture: getFixture?.() ?? null,
    }
  })
  return { elapsedMs: Date.now() - started, heap, dom, resources }
}

export const takeHeapSnapshot = async (cdp: CDPSession, path: string) => {
  const snapshot = createWriteStream(path)
  const save = ({ chunk }: { chunk: string }) => snapshot.write(chunk)
  cdp.on("HeapProfiler.addHeapSnapshotChunk", save)

  await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false, captureNumericValue: true })
  cdp.off("HeapProfiler.addHeapSnapshotChunk", save)
  await new Promise<void>((done) => snapshot.end(done))
  return getHeapSummary(path)
}

const getHeapSummary = async (path: string) => {
  const snapshot = JSON.parse(await readFile(path, "utf8")) as {
    snapshot: { meta: { node_fields: string[]; node_types: Array<string[] | string> } }
    nodes: number[]
    strings: string[]
  }
  const fields = snapshot.snapshot.meta.node_fields
  const types = snapshot.snapshot.meta.node_types[fields.indexOf("type")]
  if (!Array.isArray(types)) throw new Error("Missing heap node types")

  const nameOffset = fields.indexOf("name")
  const sizeOffset = fields.indexOf("self_size")
  const detachedOffset = fields.indexOf("detachedness")
  let detachedNodes = 0
  let nativeBufferBytes = 0
  let largestNativeBufferBytes = 0
  let wasmModuleBytes = 0
  let nativeSvgBytes = 0
  // Flat snapshots contain hundreds of thousands of nodes; keep this scan allocation-free.
  for (let index = 0; index < snapshot.nodes.length; index += fields.length) {
    if (detachedOffset >= 0 && snapshot.nodes[index + detachedOffset] === 2) detachedNodes++
    if (types[snapshot.nodes[index] ?? -1] !== "native") continue

    const name = snapshot.strings[snapshot.nodes[index + nameOffset] ?? -1]
    const bytes = snapshot.nodes[index + sizeOffset] ?? 0
    if (name?.startsWith("SVG")) nativeSvgBytes += bytes
    if (name?.includes("WasmNativeModule")) wasmModuleBytes += bytes
    if (name !== "system / JSArrayBufferData") continue

    nativeBufferBytes += bytes
    largestNativeBufferBytes = Math.max(largestNativeBufferBytes, bytes)
  }
  return { detachedNodes, nativeBufferBytes, largestNativeBufferBytes, wasmModuleBytes, nativeSvgBytes }
}

export const installMemoryCounters = () => {
  // Instrument browser APIs locally; closing the context releases these fakes and their originals.
  const request = window.requestAnimationFrame.bind(window)
  const cancel = window.cancelAnimationFrame.bind(window)
  const interval = window.setInterval.bind(window)
  const clear = window.clearInterval.bind(window)
  const frames = new Set<number>()
  const intervals = new Set<number>()
  const counters = { frames, intervals, wasmInstantiations: 0 }
  Object.assign(window, { desktopMemoryCounters: counters })
  WebAssembly.instantiate = new Proxy(WebAssembly.instantiate, {
    apply: (target, receiver, args) => {
      counters.wasmInstantiations++
      return Reflect.apply(target, receiver, args)
    },
  })
  window.requestAnimationFrame = (callback) => {
    const id = request((time) => {
      frames.delete(id)
      callback(time)
    })
    frames.add(id)
    return id
  }
  window.cancelAnimationFrame = (id) => {
    frames.delete(id)
    cancel(id)
  }
  window.setInterval = (callback, delay, ...args) => {
    const id = interval(callback, delay, ...args)
    intervals.add(id)
    return id
  }
  window.clearInterval = (id) => {
    intervals.delete(Number(id))
    clear(id)
  }
}
