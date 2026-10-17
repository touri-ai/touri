let storageScope: string | null = null

/** Destination identifiers contain the server address only, never pairing credentials. */
const normalizeScope = (scope: string | null): string | null => {
  if (!scope) return null
  const url = new URL(scope)
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Invalid server storage scope")
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
}

/** Configure before mounting the workspace. Local keys preserve existing saved data. */
export const setStorageScope = (scope: string | null): void => {
  storageScope = normalizeScope(scope)
}

export const getStorageScope = (): string | null => storageScope

/** Pass an explicit scope when an asynchronous operation must retain its original destination. */
export const scopedStorageKey = (key: string, scope: string | null = storageScope): string => {
  const normalized = normalizeScope(scope)
  return normalized ? `${key}:${encodeURIComponent(normalized)}` : key
}
