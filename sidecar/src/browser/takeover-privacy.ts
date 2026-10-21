import type { BrowserSnapshot } from "@touri/contracts"

type BrowserPreviewPage = {
  heldByUser: boolean
  privateAfterTakeover: boolean
  secretMode: boolean
  url: string
  title: string
}

type BrowserPreviewBlockReason = "human_control" | "sensitive_page"

const MAX_PREVIEW_URL_LENGTH = 8192
const MAX_PREVIEW_TITLE_LENGTH = 512

export const captureSafeBrowserPreview = async <T>({
  getPage,
  capture,
}: {
  getPage: () => BrowserPreviewPage
  capture: () => Promise<T>
}): Promise<T | null> => {
  if (getBrowserPreviewBlockReason(getPage())) return null

  const frame = await capture()
  // Take-over can begin during CDP capture, so only return a frame if control is still safe.
  if (getBrowserPreviewBlockReason(getPage())) return null

  return frame
}

export const captureCurrentBrowserControlFrame = async <T extends object>({
  getEpoch,
  canRead,
  capture,
}: {
  getEpoch: () => number
  canRead: () => boolean
  capture: () => Promise<T | null>
}): Promise<(T & { targetEpoch: number }) | null> => {
  const targetEpoch = getEpoch()
  if (!canRead()) return null
  const frame = await capture()
  if (!frame || !canRead() || getEpoch() !== targetEpoch) return null

  return { ...frame, targetEpoch }
}

const getBrowserPreviewBlockReason = (page: BrowserPreviewPage): BrowserPreviewBlockReason | null => {
  if (page.heldByUser || page.secretMode) return "human_control"
  if (page.url.length > MAX_PREVIEW_URL_LENGTH || page.title.length > MAX_PREVIEW_TITLE_LENGTH) return "sensitive_page"
  if (isSensitiveTakeoverPage(page.url, page.title)) return "sensitive_page"
  if (page.privateAfterTakeover && !sanitizeHumanTakeoverUrl(page.url)) return "sensitive_page"

  return null
}

export const sanitizeHumanTakeoverPreviewMetadata = (page: {
  url: string
  title: string
}): { title: string; url: string } => ({
  title: "",
  url: sanitizeHumanTakeoverUrl(page.url),
})

export const sanitizeHumanTakeoverSnapshot = (snapshot: BrowserSnapshot): BrowserSnapshot => ({
  ...snapshot,
  url: sanitizeHumanTakeoverUrl(snapshot.url),
  title: "",
  focus: { ...snapshot.focus, name: null },
  elements: snapshot.elements.map(({ value: _value, ...element }) => ({ ...element, name: "" })),
  text: "",
  recentActions: [],
  diagnostics: [],
  notes: [],
  image: null,
  recommendImage: null,
})

export const sanitizeHumanTakeoverUrl = (_value: string): string => ""

export const canResumeAfterHumanTakeover = ({
  url,
  title,
  hasSensitiveEntry,
  documentId,
  privateDocumentIds = [],
}: {
  url: string
  title: string
  hasSensitiveEntry: boolean
  documentId?: number | undefined
  privateDocumentIds?: ReadonlyArray<number>
}): boolean => {
  if (
    privateDocumentIds.length > 0 &&
    (documentId === undefined ||
      !Number.isFinite(documentId) ||
      privateDocumentIds.includes(0) ||
      privateDocumentIds.includes(documentId))
  )
    return false
  if (hasSensitiveEntry) return false
  if (url.length > MAX_PREVIEW_URL_LENGTH || title.length > MAX_PREVIEW_TITLE_LENGTH) return false
  if (!getBrowserPreviewPath(url)) return false

  try {
    const parsed = new URL(url)
    if (parsed.username || parsed.password) return false
  } catch {
    return false
  }

  return !isSensitiveTakeoverPage(url, title)
}

const isSensitiveTakeoverPage = (value: string, title: string): boolean => {
  const path = getBrowserPreviewPath(value)
  if (path === null) return false

  return SENSITIVE_PREVIEW_PAGE.test(`${path} ${title.slice(0, MAX_PREVIEW_TITLE_LENGTH)}`)
}

const getBrowserPreviewPath = (value: string): string | null => {
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null

    return url.pathname
  } catch {
    return null
  }
}

const SENSITIVE_PREVIEW_PAGE =
  /(?:^|[\s/_-])(?:log[ -]?in|sign[ -]?in|signin|auth(?:entication)?|checkout|payment|pay|billing|pagamento|pagar|senha|entrar)(?:$|[\s/_-])/iu

export const HAS_SENSITIVE_ENTRY_EXPRESSION = `(() => {
  const markers = /password|passwd|credential|username|user[\\s_-]*name|e[\\s_-]*mail|email|login|auth|one[\\s_-]*time|otp|verification|security[\\s_-]*code|card|cc[\\s_-]*(?:number|name|exp|csc|cvv)|cvv|cvc|payment|checkout|billing|pagamento|senha|usu[áa]rio|conta|entrar|c[óo]digo|cart[ãa]o|cpf|boleto|pix|transa[cç][ãa]o/i
  const visible = (element) => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
  }
  const fields = document.querySelectorAll("input,textarea,[contenteditable='true']")
  if (fields.length > 40) return true
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (!visible(field)) continue
    const type = String(field.type || "").slice(0, 40).toLowerCase()
    if (type === "password" || type === "email") return true
    const attributes = [type, "autocomplete", "name", "id", "aria-label", "placeholder"]
      .map((name) => name === type ? type : String(field.getAttribute(name) || "").slice(0, 120))
    if (attributes.some((value) => markers.test(value))) return true
  }
  const containers = document.querySelectorAll("form,dialog,[role='dialog'],[aria-modal='true']")
  if (containers.length > 12) return true
  for (let index = 0; index < containers.length; index += 1) {
    const container = containers[index]
    if (!visible(container)) continue
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    let text = ""
    let visited = 0
    while (walker.nextNode() && visited < 24 && text.length < 600) {
      const remaining = 600 - text.length
      text += String(walker.currentNode.nodeValue || "").slice(0, Math.min(120, remaining))
      visited += 1
    }
    if (markers.test(text)) return true
  }
  return false
})()`
