import { isAbsolute } from "node:path"
import { findThreat } from "../learning/threats"

export const isSecretPath = (path: string): boolean =>
  path
    .split(/[\\/]/)
    .some((part) =>
      /(^\.env|credentials?|tokens?|keychain|(?:^|[._-])(?:auth|oauth)(?:[._-]|$)|^\.(?:netrc|npmrc|pypirc)$|^id_(?:rsa|ed25519)|^\.(?:ssh|aws|gnupg)$|\.(?:pem|key|p12|pfx)$)/i.test(
        part,
      ),
    )

/** Bounded prefixes avoid quadratic scans of long, delimiter-free exported text. */
export const hasSecret = (text: string): boolean =>
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/.test(
    text,
  ) ||
  /(?:^|[^A-Za-z0-9_])(?:[A-Za-z0-9_]{0,48}_)?(?:(?:api|private|secret|signing)[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|senha|credentials?|authorization)["']?\s*[:=]\s*["']?[^\s"',}]+/i.test(
    text,
  ) ||
  /-----BEGIN [A-Z ]{0,32}PRIVATE KEY-----|\bBearer\s+\S+|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(
    text,
  ) ||
  /\b[a-z][a-z0-9+.-]{1,31}:\/\/[^\s/:@]{1,128}:[^\s/@]{1,256}@/.test(text)

export const isSafeText = (text: string): boolean => {
  if (hasSecret(text) || text.includes("<!--")) return false
  const windows = Array.from({ length: Math.ceil(text.length / 384) }, (_, index) =>
    text.slice(index * 384, index * 384 + 512),
  )

  return !windows.some((window) => findThreat(window, "memory"))
}

export const isSafeRelativePath = (path: string): boolean =>
  Boolean(path) &&
  !isAbsolute(path) &&
  !/[\\\0\r\n]/.test(path) &&
  path.split("/").every((part) => part !== ".." && part !== "." && Boolean(part))
