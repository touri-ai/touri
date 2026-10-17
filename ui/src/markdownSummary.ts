/** Plain text for one-line previews; preserve code and URLs before removing Markdown delimiters. */
export const markdownSummary = (source: string): string => {
  const literals: string[] = []
  const protect = (value: string): string => {
    literals.push(value)
    return `\uE000${literals.length - 1}\uE001`
  }
  const references = new Set<string>()
  let text = source
    .replace(/\r\n?/g, "\n")
    .replace(/(?:^|\n)<!-- touri:connect-data -->\s*$/, "")
    .replace(/^ {0,3}(`{3,})[^\n]*\n([\s\S]*?)(?:^ {0,3}\1`*[ \t]*$|(?![\s\S]))/gm, (_match, _fence, code: string) =>
      protect(code),
    )
    .replace(/^ {0,3}(~{3,})[^\n]*\n([\s\S]*?)(?:^ {0,3}\1~*[ \t]*$|(?![\s\S]))/gm, (_match, _fence, code: string) =>
      protect(code),
    )
    .replace(/(`+)([^`]|(?!\1)`)+?\1/g, (code) => protect(code.replace(/^`+|`+$/g, "")))
    .replace(/\\([\\`*_{}[\]()#+.!>~-])/g, (_match, literal: string) => protect(literal))
    .replace(/^ {0,3}\[([^\]]+)\]:[^\n]+$/gm, (_match, label: string) => {
      references.add(label.toLowerCase())
      return ""
    })
    .replace(/!?\[([^\]]*)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, "$1")
    .replace(/!?\[([^\]]+)\]\[([^\]]*)\]/g, (_match, label: string, reference: string) =>
      references.has((reference || label).toLowerCase()) ? label : _match,
    )
    .replace(/\[([^\]]+)\]/g, (match, label: string) => (references.has(label.toLowerCase()) ? label : match))
    .replace(/<(https?:\/\/[^>]+)>/g, (_match, url: string) => protect(url))
    .replace(
      /(\*{1,3}|_{1,3})(https?:\/\/[^\s<>]+)\1/g,
      (_match, marker: string, url: string) => `${marker}${protect(url)}${marker}`,
    )
    .replace(/(?<![\p{L}\p{N}])(?:https?:\/\/|www\.)[^\s<>]+/gu, (url) => protect(url))
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/gm, "$1")
    .replace(/^ {0,3}(?:=+|-+|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})[ \t]*$/gm, "")
    .replace(/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, " · ")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
  // Nested bold/italic delimiters may become pairs after the outer pair is removed.
  for (let pass = 0; pass < 3; pass += 1) {
    text = text
      .replace(/(\*{1,3})(?=\S)([\s\S]*?\S)\1/g, "$2")
      .replace(/(?<![\p{L}\p{N}_])(_{1,3})(?=\S)([\s\S]*?\S)\1(?![\p{L}\p{N}_])/gu, "$2")
  }
  // Restore protected fragments after all formatting passes (a URL may contain underscores or stars).
  text = text.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => literals[Number(index)] ?? "")
  return text
    .replace(/\s+/g, " ")
    .replace(/^\s*·\s*/, "")
    .trim()
}
