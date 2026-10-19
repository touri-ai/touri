import { readFile } from "node:fs/promises"
import { setDocumentLanguage } from "../src/documentLanguage"
import { DEFAULT_LOCALE } from "../src/i18n"

describe("document language", () => {
  afterEach(() => {
    document.documentElement.lang = ""
  })

  test("served document declares the default UI locale", async () => {
    const html = await readFile("index.html", "utf8")
    const document = new DOMParser().parseFromString(html, "text/html")

    expect(document.documentElement.lang).toBe(DEFAULT_LOCALE)
  })

  test("updates when the active UI locale is English", () => {
    setDocumentLanguage("en", document.documentElement)

    expect(document.documentElement.lang).toBe("en")
  })
})
