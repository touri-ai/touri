export type EvidenceImage = { path: string; caption: string; filename: string; src?: string; imageSyntax?: boolean }
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
  const references = (node: EvidenceNode): Array<{ path: string; caption: string; imageSyntax: boolean }> => {
    if (node.type === "image") return [{ path: node.url ?? "", caption: node.alt ?? "", imageSyntax: true }]
    if (node.type === "link")
      return [
        {
          path: node.url ?? "",
          caption: node.children?.map((child) => child.value ?? "").join("") ?? "",
          imageSyntax: false,
        },
      ]
    const barePaths =
      node.type === "text" || node.type === "inlineCode"
        ? [
            ...(node.value ?? "").matchAll(
              /(?:^|[\s(`])(\/?(?:[\w.@-]+\/)*[^\s<>`"'()[\]]+?\.(?:png|jpe?g|gif|webp))(?=$|[\s.,;:!?)])/gi,
            ),
          ].map((match) => ({ path: match[1] ?? "", caption: "", imageSyntax: false }))
        : []
    const children = node.type === "code" || node.type === "html" ? [] : (node.children?.flatMap(references) ?? [])
    return [...barePaths, ...children]
  }
  const allReferences = references(tree)
  const validReferences = allReferences.flatMap((reference) => {
    const path = decodedEvidencePath(reference.path, reference.imageSyntax)
    return path ? [{ ...reference, path }] : []
  })
  const firstReferences = validReferences.filter(
    (reference, index) => validReferences.findIndex((candidate) => candidate.path === reference.path) === index,
  )
  return firstReferences.map((reference) => {
    const image = validReferences.find((candidate) => candidate.path === reference.path && candidate.imageSyntax)
    const filename = reference.path.split("/").at(-1) ?? "Imagem"
    const caption = image?.caption || reference.caption || filename
    return { path: reference.path, caption, filename, imageSyntax: Boolean(image) }
  })
}
