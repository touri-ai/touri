import type { Message } from "@touri/contracts"

export const localFilePath = (href: string): string | null => {
  let path = href
  const absolute = path.startsWith("/") && !path.startsWith("//")
  try {
    if (/^file:/i.test(path)) {
      const url = new URL(path)
      if (url.host) return null
      path = url.pathname
    }
    path = decodeURIComponent(path)
  } catch {
    // A malformed escape in a local filename must still stay inside touri.
  }
  return path.startsWith("/") && !path.startsWith("//") ? path : absolute ? href : null
}

/** Shell alternatives name several possible files, not one literal preview target. */
export const hasShellBraceAlternatives = (path: string): boolean => {
  if (/\{(?:[+-]?\d+\.\.[+-]?\d+|[a-zA-Z]\.\.[a-zA-Z])(?:\.\.[+-]?\d+)?\}/.test(path)) return true

  // Local depth counters recognize nested alternatives in one pass without expanding paths.
  let depth = 0
  let commaDepth = 0
  for (const [marker] of path.matchAll(/[{},]/g)) {
    if (marker === "{") depth += 1
    if (marker === "," && depth > 0) commaDepth = depth
    if (marker !== "}" || depth === 0) continue
    if (commaDepth === depth) return true
    depth -= 1
  }
  return false
}

type FileNode = { type: string; value?: string; url?: string; children?: FileNode[] }

/** Link parsed prose and inline code only; persisted messages and fenced examples stay intact. */
export const localFileLinks = () => (tree: FileNode) => {
  const visit = (node: FileNode) => {
    if (["link", "linkReference", "image", "code", "html"].includes(node.type) || !node.children) return
    node.children = node.children.flatMap((child): FileNode[] => {
      if (child.type === "inlineCode") {
        const path = localFilePath(child.value ?? "")
        if (!path || hasShellBraceAlternatives(path)) return [child]
        return [{ type: "link", url: child.value ?? "", children: [child] }]
      }
      if (child.type !== "text") {
        visit(child)
        return [child]
      }
      const value = child.value ?? ""
      const result: FileNode[] = []
      let offset = 0
      for (const match of value.matchAll(/(?:^|[\s(])((?:file:\/\/\/|\/(?!\/))[^\s<>`"'()[\]]+)/g)) {
        const path = (match[1] ?? "").replace(/[.,;:!?]+$/, "")
        const start = (match.index ?? 0) + match[0].length - (match[1]?.length ?? 0)
        const local = localFilePath(path)
        if (!local || !/\/[^/]+\.[\w]+$/.test(path)) continue
        result.push(
          { type: "text", value: value.slice(offset, start) },
          hasShellBraceAlternatives(local)
            ? { type: "inlineCode", value: path }
            : { type: "link", url: path, children: [{ type: "text", value: path }] },
        )
        offset = start + path.length
      }
      return offset ? [...result, { type: "text", value: value.slice(offset) }] : [child]
    })
  }
  visit(tree)
}

/** Recover only flattened GFM tables with a recognizable delimiter and complete rows.
 * This is a display projection: persisted bytes and streaming offsets stay untouched. */
export const recoverLegacyMarkdown = (source: string): string => {
  let fence: { character: string; length: number } | undefined
  return source
    .split("\n")
    .map((line) => {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
      if (marker) {
        if (!fence) fence = { character: marker[0] ?? "", length: marker.length }
        else if (marker[0] === fence.character && marker.length >= fence.length && line.trim() === marker)
          fence = undefined
        return line
      }
      if (fence || line.includes("`") || /^ {4}|^\t/.test(line)) return line
      const delimiter = /\|(?:\s*:?-{3,}:?\s*\|){2,}/.exec(line)
      if (!delimiter) return line
      const columns = delimiter[0].split("|").length - 2
      const cells = Array.from({ length: columns }, () => String.raw`(?:\\.|[^|\\])*\|`).join("")
      const prefix = line.slice(0, delimiter.index)
      const header = new RegExp(String.raw`\|${cells}\s*$`).exec(prefix)
      if (!header) return line
      const rowPattern = new RegExp(String.raw`^\s*\|${cells}`)
      let tail = line.slice(delimiter.index + delimiter[0].length)
      const rows: string[] = []
      for (let row = rowPattern.exec(tail); row; row = rowPattern.exec(tail)) {
        rows.push(row[0].trim())
        tail = tail.slice(row[0].length)
      }
      if (!rows.length) return line
      const intro = prefix
        .slice(0, header.index)
        .trimEnd()
        .replace(/([.!?])(?=[A-ZÁÉÍÓÚÂÊÔÃÕÇ])/g, "$1\n\n")
      const outro = tail.trim().replace(/\s+·\s+/g, "\n- ")
      return [intro, [header[0].trim(), delimiter[0], ...rows].join("\n"), outro].filter(Boolean).join("\n\n")
    })
    .join("\n")
}

export const messageMarkdown = (message: Pick<Message, "role" | "text" | "parts">): string => {
  const segments = message.parts.filter((part) => part.type === "text").map((part) => part.text)
  if (message.role !== "assistant") return message.text || segments.join("")
  // Older snapshots retain separate parts even when their cached text has no separators.
  const text = segments.length > 1 ? segments.join("\n\n") : message.text || segments.join("")
  return recoverLegacyMarkdown(text)
}
