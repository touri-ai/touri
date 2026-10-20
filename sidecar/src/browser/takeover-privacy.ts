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
  elements: snapshot.elements.map(({ value: _value, ...element }) => element),
  text: "",
  recentActions: [],
  diagnostics: [],
  notes: [],
  image: null,
  recommendImage: null,
})

export const sanitizeHumanTakeoverUrl = (value: string): string => {
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return ""

    return url.origin
  } catch {
    return ""
  }
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
