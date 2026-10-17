export type EvidenceImage = { path: string; caption: string; filename: string; src?: string }
export type EvidenceNode = {
  type: string
  value?: string
  url?: string
  alt?: string
  children?: EvidenceNode[]
}
export const evidencePath = (path: string, imageSyntax = false): boolean =>
  !!path &&
  !/^[a-z][a-z0-9+.-]*:/i.test(path) &&
  !path.startsWith("//") &&
  !/[\\\0]/.test(path) &&
  !path.split("/").includes("..") &&
  (imageSyntax || /\.(png|jpe?g|gif|webp)$/i.test(path) || /^\/(?:api\/v1\/)?attachments\/[a-f0-9]{64}$/i.test(path))

export const decodedEvidencePath = (path: string, imageSyntax = false): string | null => {
  try {
    const decoded = decodeURIComponent(path)
    return evidencePath(decoded, imageSyntax) ? decoded : null
  } catch {
    return null
  }
}

/** Operate on parsed nodes: fenced code, raw HTML and remote URLs never become evidence. */
export const evidenceImages = (tree: EvidenceNode): EvidenceImage[] => {
  const images: EvidenceImage[] = []
  const add = (path: string, caption?: string, imageSyntax = false) => {
    const decoded = decodedEvidencePath(path, imageSyntax)
    if (!decoded || images.some((image) => image.path === decoded)) return
    const filename = decoded.split("/").at(-1) ?? "Imagem"
    images.push({ path: decoded, caption: caption || filename, filename })
  }
  const visit = (node: EvidenceNode) => {
    if (node.type === "image") {
      add(node.url ?? "", node.alt, true)
      return
    }
    if (node.type === "link") {
      add(node.url ?? "", node.children?.map((child) => child.value ?? "").join(""))
      return
    }
    if (node.type === "text" || node.type === "inlineCode") {
      // Markdown destinations already handle spaces; bare paths end at prose delimiters.
      for (const match of (node.value ?? "").matchAll(
        /(?:^|[\s(`])(\/?(?:[\w.@-]+\/)*[^\s<>`"'()[\]]+?\.(?:png|jpe?g|gif|webp))(?=$|[\s.,;:!?)])/gi,
      ))
        add(match[1] ?? "")
    }
    if (node.type !== "code" && node.type !== "html") node.children?.forEach(visit)
  }
  visit(tree)
  return images
}
