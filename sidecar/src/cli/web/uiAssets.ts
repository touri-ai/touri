import { existsSync } from "node:fs"
import { extname, isAbsolute, join, normalize, relative, resolve } from "node:path"
import { readBoundedFile } from "../../kernel/files"
import { type CompressedVariants, compressedVariants, compressibleType } from "./compression"
import { embeddedUi } from "./embeddedUi"

export type UiAsset = {
  file: Blob
  type: string
  immutable: boolean
  compressed?: () => Promise<CompressedVariants>
}

export type UiAssets = {
  source: "embedded" | "directory" | "none"
  get: (relativePath: string) => UiAsset | null
}

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
}

export const mimeFor = (path: string): string => mimeTypes[extname(path).toLowerCase()] ?? "application/octet-stream"

const toAsset = ({ path, file }: { path: string; file: Blob }): UiAsset => ({
  file,
  type: mimeFor(path),
  immutable: path.startsWith("assets/"),
})

/** Rejects absolute paths and `..` segments so a request can never leave the UI directory. */
export const safeRelativePath = (raw: string): string | null => {
  const cleaned = normalize(raw.replace(/^\/+/, ""))
  if (cleaned.startsWith("..") || isAbsolute(cleaned) || cleaned.includes("\0")) return null
  return cleaned === "." ? "" : cleaned
}

export const directoryAssets = (directory: string): UiAssets => {
  const root = resolve(directory)
  return {
    source: "directory",
    get: (relativePath) => {
      const safe = safeRelativePath(relativePath)
      if (safe === null || safe === "") return null
      const full = join(root, safe)
      const inside = relative(root, full)
      if (inside.startsWith("..") || !existsSync(full)) return null
      try {
        return toAsset({
          path: safe,
          file: new Blob([new Uint8Array(readBoundedFile({ root, path: full, maxBytes: 32 * 1024 * 1024 }))]),
        })
      } catch {
        return null
      }
    },
  }
}

export const embeddedAssets = (files: Record<string, string> = embeddedUi): UiAssets => {
  const assets = new Map<string, UiAsset>()
  return {
    source: "embedded",
    get: (relativePath) => {
      const safe = safeRelativePath(relativePath)
      const target = safe === null ? undefined : files[safe]
      if (safe === null || target === undefined) return null
      const cached = assets.get(safe)
      if (cached) return cached
      const asset = toAsset({ path: safe, file: Bun.file(target) })
      if (asset.file.size >= 1024 && compressibleType(asset.type)) {
        let compressed: Promise<CompressedVariants> | undefined
        asset.compressed = () => {
          compressed ??= asset.file.arrayBuffer().then((bytes) => compressedVariants(new Uint8Array(bytes)))
          return compressed
        }
      }
      assets.set(safe, asset)
      return asset
    },
  }
}

export const noAssets: UiAssets = { source: "none", get: () => null }

/** Picks, in order: an explicit directory, the embedded UI, ui/dist next to a source checkout. */
export const resolveUiAssets = ({
  uiDir,
  embedded = embeddedUi,
  fallbackDir,
}: {
  uiDir: string | null
  embedded?: Record<string, string>
  fallbackDir?: string
}): UiAssets => {
  if (uiDir !== null) return directoryAssets(uiDir)
  if (Object.keys(embedded).length > 0) return embeddedAssets(embedded)
  if (fallbackDir !== undefined && existsSync(join(fallbackDir, "index.html"))) return directoryAssets(fallbackDir)
  return noAssets
}
