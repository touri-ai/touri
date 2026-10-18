import type { Database } from "bun:sqlite"
import type { MessagePart } from "@touri/contracts"
import { externalizeMessageParts } from "../kernel/output-blobs"

type PartPatch = { partIndex: number; part: MessagePart }

// Completed inline output is capped in bytes and entries. Retired parts and text never enter this window.
export const STREAM_INLINE_PARTS = 128

export const createStreamPartWriter = (database: Database, appData: string, initial: MessagePart[]) => {
  const initialCandidates = initial.flatMap((part, partIndex) =>
    hasOutput(part) && isCompleted(part) ? [{ partIndex, part }] : [],
  )
  let candidates = initialCandidates.slice(0, STREAM_INLINE_PARTS)
  let reservedInlineBytes = initialCandidates
    .slice(STREAM_INLINE_PARTS)
    .reduce((total, { part }) => total + getOutputBytes(part), 0)
  let liveBytes = initial.reduce((total, part) => total + getLiveBytes(part), 0)

  return (patches: PartPatch[]): PartPatch[] => {
    const latest = new Map(patches.map((patch) => [patch.partIndex, patch]))
    const unique = Array.from(latest.values())
    const indices = new Set(latest.keys())
    const tracked = new Set(candidates.map(({ partIndex }) => partIndex))
    const previous = candidates.filter(({ partIndex }) => !indices.has(partIndex))
    const incoming = unique.filter(({ part }) => hasOutput(part) && isCompleted(part))
    const nextLiveBytes = unique.reduce(
      (total, { partIndex, part }) => total - getLiveBytes(initial[partIndex]) + getLiveBytes(part),
      liveBytes,
    )
    // Legacy snapshots may contain thousands of tiny inline results. Reserve their bytes numerically;
    // converting that entire prefix to files on the first live patch would itself block the loop.
    const nextReservedInlineBytes = unique.reduce((total, { partIndex }) => {
      const part = initial[partIndex]
      if (!part || tracked.has(partIndex) || !isCompleted(part)) return total

      return total - getOutputBytes(part)
    }, reservedInlineBytes)
    const window = incoming.reduce(getOrderedWindow, previous)
    const externalized = externalizeMessageParts({
      database,
      appData,
      parts: window.map(({ part }) => part),
      reservedBytes: nextLiveBytes + nextReservedInlineBytes,
    })
    const next = window.map(({ partIndex, part }, index) => ({ partIndex, part: externalized[index] ?? part }))
    const inline = next.filter(({ part }) => hasOutput(part) && isCompleted(part))
    const overflow = inline.slice(STREAM_INLINE_PARTS)
    const overflowParts = externalizeMessageParts({
      database,
      appData,
      parts: overflow.map(({ part }) => part),
      inlineBudgetBytes: 0,
    })
    const overflowPatches = overflow.map(({ partIndex, part }, index) => ({
      partIndex,
      part: overflowParts[index] ?? part,
    }))
    const replacements = new Map(next.concat(overflowPatches).map(({ partIndex, part }) => [partIndex, part]))
    const prepared = patches.map(({ partIndex, part }) => ({ partIndex, part: replacements.get(partIndex) ?? part }))
    const retired = previous.flatMap(({ partIndex, part }) => {
      const replacement = replacements.get(partIndex)
      if (!replacement || !hasNewAttachment(part, replacement)) return []

      return [{ partIndex, part: replacement }]
    })
    candidates = next.flatMap(({ partIndex, part }) => {
      const replacement = replacements.get(partIndex) ?? part
      if (!hasOutput(replacement)) return []

      return [{ partIndex, part: replacement }]
    })

    liveBytes = nextLiveBytes
    reservedInlineBytes = nextReservedInlineBytes

    return prepared.concat(retired)
  }
}

const getOrderedWindow = (window: PartPatch[], patch: PartPatch): PartPatch[] => {
  const index = window.findIndex(({ partIndex }) => partIndex > patch.partIndex)
  if (index < 0) return window.concat(patch)

  return window.slice(0, index).concat(patch, window.slice(index))
}

const hasOutput = (part: MessagePart): boolean => {
  if (part.type === "tool_call") return Boolean(part.outputJson || part.outputTail)
  if (part.type === "command") return Boolean(part.outputTail)
  if (part.type === "file_change") return Boolean(part.diff)

  return false
}

const isCompleted = (part: MessagePart): boolean => {
  if (!("callId" in part)) return false
  if (part.resolution) return part.resolution !== "running"
  if (part.type === "tool_call") return part.ok !== null
  if (part.type === "command") return part.exitCode !== null

  return part.diff !== null
}

const hasNewAttachment = (previous: MessagePart, next: MessagePart): boolean =>
  "outputAttachmentId" in next &&
  next.outputAttachmentId !== ("outputAttachmentId" in previous ? previous.outputAttachmentId : undefined)

const getLiveBytes = (part: MessagePart | undefined): number => {
  if (!part || isCompleted(part)) return 0

  return getOutputBytes(part)
}

const getOutputBytes = (part: MessagePart): number => {
  if (part.type === "tool_call") {
    const outputBytes = Buffer.byteLength(part.outputJson ?? "")
    const tailBytes = Buffer.byteLength(part.outputTail ?? "")

    return outputBytes + tailBytes
  }
  if (part.type === "command") return Buffer.byteLength(part.outputTail)
  if (part.type === "file_change") return Buffer.byteLength(part.diff ?? "")

  return 0
}
