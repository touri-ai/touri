export const relayHeadlessStderr = async (
  stream: ReadableStream<Uint8Array>,
  write: (text: string) => void | Promise<void>,
): Promise<void> => {
  const schedulingWarning = "Optional scheduling adjustment was denied; continuing with the existing thread policy."
  const maxBufferedLineLength = 8_192
  const isOptionalSchedulingDenial = (line: string): boolean =>
    /^Failed to apply scheduling attributes to thread [0-9]+: Operation not permitted\r?\n?$/.test(line)
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  // Streaming state stays local; oversized lines pass through until their next newline.
  let pending = ""
  let warned = false
  let continuedLine = false

  const relayLine = async (line: string): Promise<void> => {
    if (!isOptionalSchedulingDenial(line)) {
      await write(line)
      return
    }

    if (warned) return
    warned = true
    await write(`${schedulingWarning}\n`)
  }

  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break

    pending += decoder.decode(chunk.value, { stream: true })
    let newline = pending.indexOf("\n")
    while (newline !== -1) {
      const line = pending.slice(0, newline + 1)
      if (continuedLine) await write(line)
      if (!continuedLine) await relayLine(line)
      continuedLine = false
      pending = pending.slice(newline + 1)
      newline = pending.indexOf("\n")
    }

    if (pending.length <= maxBufferedLineLength) continue
    await write(pending)
    pending = ""
    continuedLine = true
  }

  pending += decoder.decode()
  if (pending && continuedLine) await write(pending)
  if (pending && !continuedLine) await relayLine(pending)
}
