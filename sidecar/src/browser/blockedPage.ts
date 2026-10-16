/** What the engine knows about a loaded page when it checks for an anti-bot challenge. */
export type BlockedPageInput = {
  url: string
  title: string
  text: string
  frames: Array<string>
  /** Ids from CHALLENGE_ELEMENT_IDS that exist on the page. */
  challengeElements: Array<string>
  /** HTTP status of the main document, or null when it was served from cache or not seen. */
  status: number | null
  /** Main document response headers, names in lower case. */
  headers: Record<string, string>
}

export type BlockedPage = { vendor: string; reason: string }

/** Element ids that only challenge pages render: Google's interstitial form and the HUMAN widget. */
export const CHALLENGE_ELEMENT_IDS = ["captcha-form", "px-captcha"] as const

const CHALLENGE_STATUS = new Set([403, 429, 503])
const SHORT_PAGE_TEXT = 400

const CAPTCHA_FRAMES: Array<{ host: RegExp; vendor: string }> = [
  { host: /(^|\.)captcha-delivery\.com$/, vendor: "DataDome" },
  { host: /^challenges\.cloudflare\.com$/, vendor: "Cloudflare" },
  { host: /(^|\.)hcaptcha\.com$/, vendor: "hCaptcha" },
  { host: /(^|\.)arkoselabs\.com$/, vendor: "Arkose Labs" },
  { host: /(^|\.)(google|recaptcha)\.(com|net)$/, vendor: "reCAPTCHA" },
]

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ""
  }
}

const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname
  } catch {
    return ""
  }
}

const captchaFrame = (src: string): string | null => {
  const host = hostOf(src)
  if (!host) return null
  const known = CAPTCHA_FRAMES.find((item) => item.host.test(host))
  if (!known) return null
  // google.com hosts many frames (maps, YouTube embeds); only its captcha paths count.
  if (known.vendor === "reCAPTCHA" && !pathOf(src).startsWith("/recaptcha")) return null
  return known.vendor
}

const isGoogleHost = (host: string): boolean => /(^|\.)google\.[a-z.]+$/.test(host)

/**
 * Recognizes a challenge or block page served instead of the content the bot asked for.
 * Page text alone never counts: an article or a search result can quote a challenge message, and a bot
 * wrongly stopped is as broken as a blocked one. Each text signature needs a corroborating signal
 * (the challenge URL, element, title, status or header).
 */
export const classifyBlockedPage = (page: BlockedPageInput): BlockedPage | null => {
  const host = hostOf(page.url)
  const title = page.title.trim()
  const text = page.text
  const server = (page.headers.server ?? "").toLowerCase()
  const challengeStatus = page.status !== null && CHALLENGE_STATUS.has(page.status)
  const element = (id: (typeof CHALLENGE_ELEMENT_IDS)[number]): boolean => page.challengeElements.includes(id)

  if (
    isGoogleHost(host) &&
    (pathOf(page.url).startsWith("/sorry/") || element("captcha-form")) &&
    (challengeStatus || /unusual traffic from your computer network|detectaram tráfego incomum/i.test(text))
  )
    return { vendor: "Google", reason: "tráfego incomum" }

  if (/^access denied$/i.test(title) && /reference\s*#\s*\d+\.[0-9a-f.]+/i.test(text))
    return { vendor: "Akamai", reason: "acesso negado" }
  if (server.includes("akamaighost") && page.status === 403 && /access denied/i.test(`${title}\n${text}`))
    return { vendor: "Akamai", reason: "acesso negado" }

  // A tab opened straight on a URL can miss the response headers, so the page text also counts.
  const cloudflare = server === "cloudflare" || /cloudflare|ray id/i.test(text)
  if ((page.headers["cf-mitigated"] ?? "").toLowerCase() === "challenge")
    return { vendor: "Cloudflare", reason: "verificação de navegador" }
  if (/^(just a moment|um momento)(\.\.\.|…)?$/i.test(title) && cloudflare)
    return { vendor: "Cloudflare", reason: "verificação de navegador" }
  if (
    (challengeStatus || /^attention required!? \| cloudflare$/i.test(title)) &&
    /cloudflare ray id/i.test(text) &&
    /you have been blocked|you are unable to access/i.test(text)
  )
    return { vendor: "Cloudflare", reason: "acesso negado" }
  if (server === "cloudflare" && challengeStatus && /verify you are human|verifique se você é humano/i.test(text))
    return { vendor: "Cloudflare", reason: "verificação de navegador" }

  if (
    (page.status === 403 || element("px-captcha")) &&
    /press\s*(&|and)\s*hold to confirm you are\s*a human/i.test(text)
  )
    return { vendor: "HUMAN (PerimeterX)", reason: "verificação de navegador" }

  const frameVendor = page.frames.map(captchaFrame).find((vendor) => vendor !== null)
  if (frameVendor === "DataDome") return { vendor: "DataDome", reason: "captcha" }
  if (frameVendor && (challengeStatus || text.trim().length < SHORT_PAGE_TEXT))
    return { vendor: frameVendor, reason: "captcha" }

  return null
}

/** pt-BR message for SITE_BLOCKED; names the site and the next steps, never page content. */
export const describeBlockedPage = ({ blocked, url }: { blocked: BlockedPage; url: string }): string => {
  const site = hostOf(url) || "o site"
  return `${site} mostrou uma página de bloqueio anti-bot (${blocked.vendor}: ${blocked.reason}) em vez do conteúdo pedido. Não repita a mesma ação. Chame browser_request_takeover nesta aba para a pessoa resolver o desafio, ou avise que este site recusa acesso automatizado.`
}
