import { JSDOM } from "jsdom"
import { afterEach, describe, expect, it, vi } from "vitest"
import { pairingPageHtml } from "../../sidecar/src/cli/web/pairingPage"

const pages = new Set<JSDOM>()

afterEach(() => {
  pages.forEach((page) => {
    page.window.close()
  })
  pages.clear()
  vi.useRealTimers()
})

const makePage = (language: string, fetch: typeof globalThis.fetch): JSDOM => {
  const page = new JSDOM(pairingPageHtml, {
    url: "https://team.example.test/login#signin=synthetic-token",
    runScripts: "dangerously",
    beforeParse: (window) => {
      Object.defineProperty(window.navigator, "language", { value: language })
      window.fetch = fetch
    },
  })
  pages.add(page)
  return page
}

describe("email sign-in recovery", () => {
  it.each(["pt-BR", "en"])("keeps progress visible and recovers from an invalid link in %s", async (language) => {
    const redeem = Promise.withResolvers<Response>()
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(redeem.promise)

    const page = makePage(language, fetch)
    const document = page.window.document
    const status = document.getElementById("email-status")

    expect(page.window.location.hash).toBe("")
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/auth/email/redeem",
      expect.objectContaining({ body: expect.stringContaining("synthetic-token") }),
    )
    expect(status?.closest("[hidden]")).toBeNull()
    expect(status?.textContent).toContain(language === "en" ? "Connecting" : "Conectando")

    redeem.resolve(Response.json({ errorCode: "INVALID_SIGN_IN" }, { status: 401 }))

    await vi.waitFor(() => expect(status?.textContent).toContain(language === "en" ? "expired" : "expirou"))
    expect(status?.closest("[hidden]")).toBeNull()
    expect(document.getElementById("email-form")?.hasAttribute("hidden")).toBe(false)
    expect(document.getElementById("pair-form")?.hasAttribute("hidden")).toBe(false)

    fetch.mockResolvedValueOnce(Response.json({ ok: true }, { status: 202 }))
    const email = document.getElementById("email")
    if (!(email instanceof page.window.HTMLInputElement)) throw new Error("Email input is missing")
    email.value = "ana@example.test"
    document.getElementById("email-form")?.dispatchEvent(new page.window.Event("submit", { cancelable: true }))

    await vi.waitFor(() => expect(status?.textContent).toContain(language === "en" ? "has access" : "tiver acesso"))
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/v1/auth/email",
      expect.objectContaining({ body: JSON.stringify({ email: "ana@example.test" }) }),
    )
  })

  it("restores both sign-in methods after a network failure", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("Synthetic network failure"))

    const page = makePage("pt-BR", fetch)
    const document = page.window.document
    const status = document.getElementById("email-status")

    await vi.waitFor(() => expect(status?.textContent).toContain("Não foi possível falar com o servidor"))
    expect(status?.closest("[hidden]")).toBeNull()
    expect(document.getElementById("email-form")?.hasAttribute("hidden")).toBe(false)
    expect(document.getElementById("pair-form")?.hasAttribute("hidden")).toBe(false)
  })

  it("cancels a stalled redemption and restores the sign-in controls after 15 seconds", async () => {
    vi.useFakeTimers()
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (_resource, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("Synthetic request cancellation")))
        }),
    )
    const page = makePage("pt-BR", fetch)
    const document = page.window.document

    await vi.advanceTimersByTimeAsync(15_001)

    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    expect(document.getElementById("email-status")?.textContent).toContain("Não foi possível falar com o servidor")
    expect(document.getElementById("email-form")?.hasAttribute("hidden")).toBe(false)
    expect(document.getElementById("pair-form")?.hasAttribute("hidden")).toBe(false)
  })
})
