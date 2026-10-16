import { describe, expect, test } from "bun:test"
import { type BlockedPageInput, classifyBlockedPage, describeBlockedPage } from "../../src/browser/blockedPage"

const page = (input: Partial<BlockedPageInput>): BlockedPageInput => ({
  url: "https://shop.example.test/product/123",
  title: "Product 123",
  text: "A long product description with price, sizes and reviews. ".repeat(20),
  frames: [],
  challengeElements: [],
  status: 200,
  headers: {},
  ...input,
})

describe("classifyBlockedPage", () => {
  test("Google unusual-traffic interstitial needs its URL or form plus a status or its message", () => {
    expect(
      classifyBlockedPage(page({ url: "https://www.google.com/sorry/index?continue=x", title: "", status: 429 })),
    ).toEqual({ vendor: "Google", reason: "tráfego incomum" })
    expect(
      classifyBlockedPage(
        page({
          url: "https://www.google.com.br/sorry/index?continue=x",
          text: "Nossos sistemas detectaram tráfego incomum na sua rede de computadores.",
          challengeElements: ["captcha-form"],
          status: null,
        }),
      ),
    ).toMatchObject({ vendor: "Google" })
  })

  test("a Google results page or article that quotes the interstitial message is not blocked", () => {
    const quote = 'Why does Google say "Our systems have detected unusual traffic from your computer network"?'
    expect(
      classifyBlockedPage(
        page({
          url: "https://www.google.com/search?q=unusual+traffic",
          title: "unusual traffic - Google",
          text: quote,
        }),
      ),
    ).toBeNull()
    expect(
      classifyBlockedPage(page({ url: "https://support.google.com/websearch/answer/86640", text: quote })),
    ).toBeNull()
    expect(classifyBlockedPage(page({ text: quote }))).toBeNull()
    expect(classifyBlockedPage(page({ url: "https://www.google.com/sorry/index", status: 200 }))).toBeNull()
  })

  test("Akamai Access Denied with a reference number", () => {
    expect(
      classifyBlockedPage(
        page({
          title: "Access Denied",
          text: 'Access Denied\nYou don\'t have permission to access "https://shop.example.test/" on this server.\nReference #18.1a2b3c4d.1700000000.5e6f7a8b',
          status: 403,
        }),
      ),
    ).toEqual({ vendor: "Akamai", reason: "acesso negado" })
    expect(
      classifyBlockedPage(
        page({ title: "Access Denied", text: "Access Denied", status: 403, headers: { server: "AkamaiGHost" } }),
      ),
    ).toMatchObject({ vendor: "Akamai" })
  })

  test("an application's own access-denied page is not an anti-bot block", () => {
    expect(
      classifyBlockedPage(
        page({ title: "Access denied", text: "Ask your admin for access to this project.", status: 403 }),
      ),
    ).toBeNull()
  })

  test("Cloudflare challenge by header, by title, and the Cloudflare block page", () => {
    expect(
      classifyBlockedPage(page({ title: "Just a moment...", status: 403, headers: { "cf-mitigated": "challenge" } })),
    ).toEqual({ vendor: "Cloudflare", reason: "verificação de navegador" })
    expect(
      classifyBlockedPage(
        page({ title: "Just a moment...", text: "", status: 503, headers: { server: "cloudflare" } }),
      ),
    ).toMatchObject({ vendor: "Cloudflare" })
    expect(
      classifyBlockedPage(
        page({
          title: "Attention Required! | Cloudflare",
          text: "Sorry, you have been blocked\nYou are unable to access shop.example.test\nCloudflare Ray ID: 0123456789abcdef",
          status: 403,
          headers: { server: "cloudflare" },
        }),
      ),
    ).toEqual({ vendor: "Cloudflare", reason: "acesso negado" })
  })

  test("Cloudflare challenge without response headers, as on a freshly opened tab", () => {
    expect(
      classifyBlockedPage(
        page({
          title: "Just a moment...",
          text: "shop.example.test needs to review the security of your connection before proceeding.\nRay ID: 0123456789abcdef\nPerformance & security by Cloudflare",
          status: null,
        }),
      ),
    ).toEqual({ vendor: "Cloudflare", reason: "verificação de navegador" })
    expect(classifyBlockedPage(page({ title: "Just a moment...", status: null }))).toBeNull()
  })

  test("a normal page served by Cloudflare that mentions human verification is not blocked", () => {
    expect(
      classifyBlockedPage(
        page({ text: "How to verify you are human on our forum.", status: 200, headers: { server: "cloudflare" } }),
      ),
    ).toBeNull()
  })

  test("an article that quotes the Cloudflare block page is not blocked", () => {
    expect(
      classifyBlockedPage(
        page({
          title: "How to fix Sorry, you have been blocked",
          text: 'The page says "Sorry, you have been blocked" and shows a Cloudflare Ray ID at the bottom.',
        }),
      ),
    ).toBeNull()
  })

  test("HUMAN (PerimeterX) press-and-hold challenge needs a 403 or its widget", () => {
    const challenge = "Press & Hold to confirm you are a human (and not a bot)."
    expect(classifyBlockedPage(page({ text: challenge, status: 403 }))).toMatchObject({ vendor: "HUMAN (PerimeterX)" })
    expect(
      classifyBlockedPage(page({ text: challenge, challengeElements: ["px-captcha"], status: null })),
    ).toMatchObject({ vendor: "HUMAN (PerimeterX)" })
  })

  test("a troubleshooting article that quotes the press-and-hold message is not blocked", () => {
    expect(
      classifyBlockedPage(
        page({
          url: "https://help.example.test/articles/press-and-hold",
          title: "What does Press & Hold mean?",
          text: 'Some shops show "Press & Hold to confirm you are a human (and not a bot)." Here is why.',
        }),
      ),
    ).toBeNull()
  })

  test("captcha frames count only on a challenge status or an almost empty page", () => {
    expect(
      classifyBlockedPage(page({ text: "", frames: ["https://geo.captcha-delivery.com/captcha/?initialCid=x"] })),
    ).toEqual({ vendor: "DataDome", reason: "captcha" })
    expect(
      classifyBlockedPage(page({ status: 429, frames: ["https://www.google.com/recaptcha/api2/anchor?k=x"] })),
    ).toEqual({ vendor: "reCAPTCHA", reason: "captcha" })
    expect(
      classifyBlockedPage(page({ text: "Please wait.", frames: ["https://newassets.hcaptcha.com/captcha/v1/x"] })),
    ).toMatchObject({ vendor: "hCaptcha" })
    expect(classifyBlockedPage(page({ frames: ["https://www.google.com/recaptcha/api2/anchor?k=x"] }))).toBeNull()
    expect(classifyBlockedPage(page({ text: "Map", frames: ["https://www.google.com/maps/embed?pb=x"] }))).toBeNull()
  })

  test("ordinary pages, including unreadable URLs, are not blocked", () => {
    expect(classifyBlockedPage(page({}))).toBeNull()
    expect(classifyBlockedPage(page({ url: "about:blank", title: "", text: "", status: null }))).toBeNull()
  })
})

test("describeBlockedPage names the site and the next steps without page content", () => {
  const message = describeBlockedPage({
    blocked: { vendor: "Akamai", reason: "acesso negado" },
    url: "https://shop.example.test/product/123?token=abc",
  })
  expect(message).toContain("shop.example.test")
  expect(message).toContain("Akamai")
  expect(message).toContain("browser_request_takeover")
  expect(message).not.toContain("token=abc")
})
