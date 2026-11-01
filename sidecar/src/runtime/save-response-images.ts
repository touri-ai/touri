import type { Database } from "bun:sqlite"
import { join } from "node:path"
import type { Bot, Kernel, MessagePart } from "@touri/contracts"
import { getWorkspaceImageAsync, writePrivateFileAsync } from "../kernel/async-files"
import { writeDatabaseAsync } from "../kernel/database-write"
import { evidenceImageRoute, imagePath } from "../vm/evidence-images"

/** Only references in assistant prose are captured; tool output and fenced code are excluded. */
export const getResponseImagePaths = (text: string): string[] => {
  const prose = text.slice(0, 1024 * 1024).replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, "")
  const paths = Array.from(
    prose.matchAll(
      /`([^`\n]+\.(?:png|jpe?g|gif|webp))`|(?:[\s`(]|^)([^\s<>`"'()[\]]+\.(?:png|jpe?g|gif|webp))(?=[\s`)\],.;!?]|$)/gi,
    ),
    (match) => match[1] ?? match[2] ?? "",
  )

  const decoded = paths.flatMap((path) => {
    try {
      return [decodeURIComponent(path)]
    } catch {
      return []
    }
  })
  return [...new Set(decoded)]
    .filter((path) => path.length <= 4096 && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(path))
    .slice(0, 12)
}

export const saveResponseImages = async ({
  kernel,
  database,
  bot,
  parts,
  signal = AbortSignal.timeout(30_000),
}: {
  kernel: Kernel
  database: Database
  bot: Bot
  parts: MessagePart[]
  signal?: AbortSignal
}): Promise<MessagePart[]> => {
  const paths = getResponseImagePaths(parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"))
  if (!paths.length || signal.aborted) return parts

  const project = bot.projectId
    ? (database.query("SELECT path FROM projects WHERE id = ? AND archived_at IS NULL").get(bot.projectId) as {
        path: string
      } | null)
    : null
  const saved = new Map<string, { path: string; attachmentId: string }>()
  for (const path of paths) {
    try {
      if (signal.aborted) break
      const image = await getResponseImage(kernel, bot, project?.path, path, signal)
      signal.throwIfAborted()
      if (!("bytes" in image)) continue
      const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(image.bytes))
      const id = Buffer.from(digest).toString("hex")
      const existing = database.query("SELECT path FROM attachments WHERE id = ?").get(id) as { path: string } | null
      const destination = existing?.path ?? join(kernel.paths.attachmentsDir, id)
      imagePath(kernel.paths.attachmentsDir, destination)
      await writePrivateFileAsync({ root: kernel.paths.appData, path: destination, content: image.bytes })
      await writeDatabaseAsync(database, () => {
        database
          .query("INSERT OR IGNORE INTO attachments (id,path,mime,bytes,origin_path,created_at) VALUES (?,?,?,?,?,?)")
          .run(id, destination, image.mime, image.bytes.length, path, Date.now())
      })
      saved.set(path, { path, attachmentId: id })
    } catch {
      // A missing or denied reference must never fail delivery of the assistant response.
    }
  }

  return parts.map((part) => {
    if (part.type !== "text") return part
    const images = getResponseImagePaths(part.text).flatMap((path) => {
      const image = saved.get(path)
      return image ? [image] : []
    })
    return images.length ? { ...part, images } : part
  })
}

const getResponseImage = async (
  kernel: Kernel,
  bot: Bot,
  projectPath: string | undefined,
  path: string,
  signal: AbortSignal,
) => {
  if (bot.machine !== "vm" && bot.machine !== "cloud")
    return getWorkspaceImageAsync({ appData: kernel.paths.appData, bot, projectPath, path, capture: true })
  const vm = kernel.services.use("vm.runtime")
  if (!vm) throw new Error("Machine unavailable")
  const result = await evidenceImageRoute(kernel, vm, true).handler({
    params: { id: bot.id },
    query: { path },
    body: null,
    signal,
  })
  if (!("stream" in result) || result.status !== 200) throw new Error("Image unavailable")
  const bytes = new Uint8Array(await new Response(result.stream).arrayBuffer())
  return { bytes, mime: result.mime }
}
