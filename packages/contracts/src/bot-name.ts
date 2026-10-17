/** Shared by creation, settings and self-service rename. Display names may include Unicode and punctuation. */
export const normalizeBotName = (value: unknown): string | null => {
  if (typeof value !== "string" || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) return null
  const name = value.trim()
  return name.length > 0 && [...name].length <= 80 ? name : null
}
