// An opening fence may follow a list marker; a closing fence carries nothing after its marker.
const FENCE_OPEN = /^\s*(?:(?:\d{1,9}[.)]|[-*+])\s+)?(`{3,}|~{3,})/
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/
const LIST_ITEM = /^(?:\d{1,9}[.)]|[-*+]) /
const ITEMS_PER_CHUNK = 10

const isListItem = (line: string): boolean => LIST_ITEM.test(line)

/**
 * Splits streaming Markdown into blocks that stop changing once later text arrives, so each finished
 * block renders once. Blocks break only outside code fences: at a blank line that does not continue an
 * indented item, and every few top-level list items (an ordered chunk keeps its number as its start).
 * The complete text is unchanged when the blocks are joined; the final render uses the whole message.
 */
export const splitStreamingBlocks = (content: string): string[] => {
  const lines = content.split("\n")
  // A line scanner on every streaming update: local arrays are built in place to stay linear.
  const blocks: string[] = []
  let block: string[] = []
  let fence: string | null = null
  let items = 0
  lines.forEach((line, index) => {
    if (fence !== null) {
      block.push(line)
      const closing = FENCE_CLOSE.exec(line)?.[1]
      if (closing && closing[0] === fence[0] && closing.length >= fence.length) fence = null
      return
    }
    const opening = FENCE_OPEN.exec(line)?.[1]
    if (opening) fence = opening
    const item = isListItem(line)
    if (item && items > 0 && items % ITEMS_PER_CHUNK === 0) {
      blocks.push(block.join("\n"))
      block = []
    }
    if (item) items += 1
    else if (line.trim() !== "" && !/^\s/.test(line)) items = 0
    block.push(line)
    const next = lines[index + 1]
    if (line.trim() !== "" || fence !== null || next === undefined || next.trim() === "" || /^\s/.test(next)) return

    blocks.push(block.join("\n"))
    block = []
    items = 0
  })

  return block.length > 0 ? [...blocks, block.join("\n")] : blocks
}
