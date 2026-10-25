import { hasShellBraceAlternatives } from "../messageMarkdown"

export type EvidenceImage = {
  path: string
  caption: string
  filename: string
  src?: string
  imageSyntax?: boolean
  read?: () => Promise<Blob>
  cacheKey?: object
}
export type EvidenceNode = {
  type: string
  value?: string
  url?: string
  alt?: string
  identifier?: string
  children?: EvidenceNode[]
}
export const evidencePath = (path: string, imageSyntax = false): boolean =>
  !!path &&
  path.length <= 4096 &&
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
  const definitions = getReferenceDefinitions(tree)
  const references = (node: EvidenceNode): Array<{ path: string; caption: string; imageSyntax: boolean }> => {
    const path = node.url ?? definitions.get(node.identifier ?? "") ?? ""
    if (node.type === "image" || node.type === "imageReference")
      return [{ path, caption: node.alt ?? "", imageSyntax: true }]
    if (node.type === "link" || node.type === "linkReference")
      return [
        {
          path,
          caption: node.children?.map((child) => child.value ?? "").join("") ?? "",
          imageSyntax: false,
        },
      ]
    if (node.type === "inlineCode" && decodedEvidencePath(node.value ?? ""))
      return [{ path: node.value ?? "", caption: "", imageSyntax: false }]
    const barePaths =
      node.type === "text" || node.type === "inlineCode"
        ? [
            ...(node.value ?? "").matchAll(
              /(?:^|[\s(`])([^\s<>`"'()[\]]+?\.(?:png|jpe?g|gif|webp))(?=$|[\s.,;:!?)])/gi,
            ),
          ].map((match) => ({ path: match[1] ?? "", caption: "", imageSyntax: false }))
        : []
    const children = node.type === "code" || node.type === "html" ? [] : (node.children?.flatMap(references) ?? [])
    return [...barePaths, ...children]
  }
  const allReferences = references(tree)
  const validReferences = allReferences.flatMap((reference) => {
    const path = decodedEvidencePath(reference.path, reference.imageSyntax)
    return path && !hasShellBraceAlternatives(path) ? [{ ...reference, path }] : []
  })
  // Local membership checks keep long file lists linear while preserving their first caption.
  const seen = new Set<string>()
  const firstReferences = validReferences.filter((reference) => {
    if (seen.has(reference.path)) return false
    seen.add(reference.path)

    return true
  })
  return firstReferences.slice(0, 12).map((reference) => {
    const image = validReferences.find((candidate) => candidate.path === reference.path && candidate.imageSyntax)
    const filename = reference.path.split("/").at(-1) ?? "Imagem"
    const caption = image?.caption || reference.caption || filename
    return { path: reference.path, caption, filename, imageSyntax: Boolean(image) }
  })
}

const getReferenceDefinitions = (tree: EvidenceNode): ReadonlyMap<string, string> => {
  // Local membership preserves the first Markdown definition and keeps lookup work linear.
  const definitions = new Map<string, string>()
  const collect = (node: EvidenceNode): void => {
    if (node.type === "code" || node.type === "html") return
    if (node.type === "definition" && node.identifier && node.url && !definitions.has(node.identifier))
      definitions.set(node.identifier, node.url)
    node.children?.forEach(collect)
  }
  collect(tree)

  return definitions
}
