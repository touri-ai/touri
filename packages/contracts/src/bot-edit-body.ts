/** Escape instruction text in frame-sized slices so saving cannot stall Work controls. */
export const getBotEditBody = async (
  input: unknown,
  yieldTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  signal?: AbortSignal,
): Promise<string | Blob> => {
  signal?.throwIfAborted()
  if (!input || typeof input !== "object" || !("instructions" in input) || typeof input.instructions !== "string")
    return JSON.stringify(input)
  if (input.instructions.length <= 65_536) return JSON.stringify(input)

  const metadata = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "instructions"))
  const header = JSON.stringify(metadata)
  const parts: string[] = [header.slice(0, -1), header === "{}" ? '"instructions":"' : ',"instructions":"']
  const instructions = input.instructions
  // The parts and offsets belong only to this request. Each escape operation is bounded.
  for (let offset = 0; offset < instructions.length; ) {
    signal?.throwIfAborted()
    let end = Math.min(offset + 16_384, instructions.length)
    const last = instructions.charCodeAt(end - 1)
    if (end < instructions.length && last >= 0xd800 && last <= 0xdbff) end -= 1
    parts.push(JSON.stringify(instructions.slice(offset, end)).slice(1, -1))
    offset = end
    if (parts.length % 16 === 0) await yieldTask()
  }
  parts.push('"}')
  return new Blob(parts, { type: "application/json" })
}
