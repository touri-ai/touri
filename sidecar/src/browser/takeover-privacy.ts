import type { BrowserSnapshot } from "@touri/contracts"

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
