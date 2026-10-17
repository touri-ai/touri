const patternRules: Array<RegExp> = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bghp_[A-Za-z0-9]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
  /\b[a-z][a-z0-9+.-]{1,31}:\/\/[^\s/:@]{1,128}:[^\s/@]{1,256}@[^\s]{0,2048}/gi,
  /\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:Bearer|Basic)\s+[^\s,;"'}]+/gi,
  /\b(?:[a-z0-9]+[_-])*(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|token)\b["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;\]}]+)/gi,
]

const registries = new WeakMap<(text: string) => string, Set<string>>()
export const redactionValues = (redact: (text: string) => string): readonly string[] => [
  ...(registries.get(redact) ?? []),
]
const representations = (value: string): string[] => [
  value,
  JSON.stringify(value).slice(1, -1),
  value
    .split("")
    .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .join(""),
]
const credentialField =
  /(?:^|[_-])(?:authorization|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|token|credential)$/i

const maskKnownValues = (text: string, forms: readonly string[]): string => {
  const matches = [...new Set(forms)].filter(Boolean).map((form) => ({ form, start: text.indexOf(form) }))
  let output = ""
  let cursor = 0
  while (true) {
    const start = matches.reduce((first, match) => (match.start >= 0 ? Math.min(first, match.start) : first), Infinity)
    if (!Number.isFinite(start)) break
    let end = start
    let expanded = true
    while (expanded) {
      expanded = false
      for (const match of matches) {
        while (match.start >= 0 && match.start <= end) {
          end = Math.max(end, match.start + match.form.length)
          match.start = text.indexOf(match.form, match.start + 1)
          expanded = true
        }
      }
    }
    output += `${text.slice(cursor, start)}[REDACTED]`
    cursor = end
  }
  return output + text.slice(cursor)
}

export const redactStructured = (value: unknown, redact: (text: string) => string): unknown => {
  if (typeof value === "string") return redact(value)
  if (value instanceof Error) return { name: redact(value.name), message: redact(value.message) }
  if (Array.isArray(value)) return value.map((item) => redactStructured(item, redact))
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redact(key),
        credentialField.test(key) && item !== null ? "[REDACTED]" : redactStructured(item, redact),
      ]),
    )
  return value
}

// Redact complete values first, then retain any suffix that could be the next
// value's prefix. The registry is queried on every delta, including late exports.
export const createStreamingRedactor = (redact: (text: string) => string, extra: readonly string[] = []) => {
  let tail = ""
  const push = (delta: string): string => {
    const text = tail + delta
    const forms = [...redactionValues(redact), ...extra].flatMap(representations).filter(Boolean)
    let retained = 0
    for (const secret of forms) {
      for (let size = Math.min(secret.length - 1, text.length); size > retained; size--) {
        if (text.endsWith(secret.slice(0, size))) {
          retained = size
          break
        }
      }
    }
    let cut = text.length - retained
    // A retained prefix must not cut a complete overlapping credential in half.
    // Keep that whole span pending too; generic token rules run only on safe text.
    let previous = -1
    while (previous !== cut) {
      previous = cut
      for (const secret of forms) {
        let start = text.indexOf(secret)
        while (start >= 0 && start < cut) {
          if (start + secret.length > cut) cut = start
          start = text.indexOf(secret, start + 1)
        }
      }
    }
    tail = text.slice(cut)
    return redact(maskKnownValues(text.slice(0, cut), forms))
  }
  // At the end of the stream the retained tail is only a possible prefix, never a whole value.
  // Short prefixes ("s" of an `sk-` token) are ordinary text; longer ones stay masked.
  const flush = (): string => {
    const forms = [...redactionValues(redact), ...extra].flatMap(representations).filter(Boolean)
    const harmless =
      tail.length < 8 && forms.every((secret) => !secret.startsWith(tail) || tail.length * 2 <= secret.length)
    const result = !tail ? "" : harmless ? redact(tail) : "[REDACTED]"
    tail = ""
    return result
  }
  return { push, flush }
}

export const createRedactor = () => {
  const values = new Set<string>()

  const addRedactionValue = (value: string): void => {
    if (value.length > 0) values.add(value)
  }

  const redact = (text: string): string => {
    let result = maskKnownValues(text, [...values].flatMap(representations))
    for (const pattern of patternRules) result = result.replace(pattern, "[REDACTED]")
    return result
  }

  registries.set(redact, values)
  return { addRedactionValue, redact }
}
