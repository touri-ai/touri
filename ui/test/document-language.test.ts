import { readFile } from "node:fs/promises"
import { getDocumentLocale, setDocumentLanguage } from "../src/documentLanguage"
import { DEFAULT_LOCALE } from "../src/i18n"

describe("document language", () => {
  test("served document declares the default UI locale", async () => {
    const html = await readFile("index.html", "utf8")
    const document = new DOMParser().parseFromString(html, "text/html")

    expect(document.documentElement.lang).toBe(DEFAULT_LOCALE)
  })

  test("updates when the active UI locale is English", () => {
    const documentElement = document.createElement("html")
    setDocumentLanguage("en", documentElement)

    expect(documentElement.lang).toBe("en")
  })

  test("reads English and falls back to the default locale", () => {
    const englishDocumentElement = document.createElement("html")
    setDocumentLanguage("en", englishDocumentElement)
    const defaultDocumentElement = document.createElement("html")

    expect(getDocumentLocale(englishDocumentElement)).toBe("en")
    expect(getDocumentLocale(defaultDocumentElement)).toBe(DEFAULT_LOCALE)
  })
})
