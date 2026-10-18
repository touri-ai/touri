/** Telegram counts message length in UTF-16 code units, which is what String.length measures. */
export const TELEGRAM_MESSAGE_LIMIT = 4096
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/

// Keep a supplementary Unicode character together at a chunk boundary.
const boundary = (text: string, end: number): number =>
  end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "") && /[\uDC00-\uDFFF]/.test(text[end] ?? "")
    ? end - 1
    : end

const plainChunks = (text: string, limit: number): Array<string> => {
  const chunks: Array<string> = []
  for (let start = 0; start < text.length; ) {
    const end = boundary(text, Math.min(start + limit, text.length))
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks
}

/** Split at line breaks where possible, closing and reopening ordinary fenced code blocks. */
export const splitMessage = (text: string, limit = TELEGRAM_MESSAGE_LIMIT): Array<string> => {
  if (!Number.isSafeInteger(limit) || limit < 8) throw new RangeError("Message limit must be at least 8")
  if (text.length <= limit) return text.trim() ? [text] : []
  const lines = text.split("\n")
  // An oversized fence cannot be repeated within the limit. Deliver it as bounded plain text.
  if (lines.some((line) => FENCE.test(line) && line.length * 2 + 4 > limit)) return plainChunks(text, limit)
  const chunks: Array<string> = []
  let current = ""
  let fence: { marker: string; opener: string } | null = null
  const reserve = () => (fence ? fence.marker.length + 1 : 0)
  const flush = () => {
    if (current && current !== fence?.opener) chunks.push(current + (fence ? `\n${fence.marker}` : ""))
    current = fence?.opener ?? ""
  }
  for (const line of lines) {
    const match = line.match(FENCE)
    const marker = match?.[1]
    const closing = !!(
      marker &&
      fence &&
      marker[0] === fence.marker[0] &&
      marker.length >= fence.marker.length &&
      !match?.[2]?.trim()
    )
    const opening: { marker: string; opener: string } | null = marker && !fence ? { marker, opener: line } : null
    const endingReserve = closing ? 0 : opening ? opening.marker.length + 1 : reserve()
    if (current.length + 1 + line.length + endingReserve > limit) flush()
    if (line.length + current.length + (current ? 1 : 0) + endingReserve <= limit) {
      current += `${current ? "\n" : ""}${line}`
    } else {
      let rest = line
      while (rest) {
        const budget = limit - current.length - (current ? 1 : 0) - reserve()
        const end = boundary(rest, Math.min(budget, rest.length))
        current += `${current ? "\n" : ""}${rest.slice(0, end)}`
        rest = rest.slice(end)
        if (rest) flush()
      }
    }
    if (opening) fence = opening
    else if (closing) fence = null
  }
  flush()
  return chunks.filter((chunk) => chunk.trim())
}
