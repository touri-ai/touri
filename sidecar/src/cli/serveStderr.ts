const schedulingWarning = "Optional scheduling adjustment was denied; continuing with the existing thread policy."
const maxBufferedLineLength = 8_192

export const relayHeadlessStderr = async (
  stream: ReadableStream<Uint8Array>,
  write: (text: string) => void | Promise<void>,
): Promise<void> => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  let schedulingDenials = 0

  const relayLine = async (line: string): Promise<void> => {
    if (!isOptionalSchedulingDenial(line)) {
      await write(line)
      return
    }

    schedulingDenials += 1
    if (schedulingDenials === 1) await write(`${schedulingWarning}\n`)
  }

  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break

    pending += decoder.decode(chunk.value, { stream: true })
    let newline = pending.indexOf("\n")
    while (newline !== -1) {
      await relayLine(pending.slice(0, newline + 1))
      pending = pending.slice(newline + 1)
      newline = pending.indexOf("\n")
    }

    if (pending.length <= maxBufferedLineLength) continue
    await write(pending)
    pending = ""
  }

  pending += decoder.decode()
  if (pending) await relayLine(pending)
  if (schedulingDenials > 1) await write(`Suppressed ${schedulingDenials - 1} additional scheduling denials.\n`)
}

const isOptionalSchedulingDenial = (line: string): boolean =>
  /^Failed to apply scheduling attributes to thread [0-9]+: Operation not permitted\r?\n?$/.test(line)
