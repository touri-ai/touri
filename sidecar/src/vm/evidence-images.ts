import type { Database } from "bun:sqlite"
import { closeSync, fstatSync, readSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import type { Bot, Kernel, RouteModule, RouteResponse, VmRuntime } from "@touri/contracts"
import { getLocalImageAsync, getWorkspaceImageAsync } from "../kernel/async-files"
import { openWorkspaceDirectory, openWorkspaceEntry } from "../kernel/files"
import { getImagePattern, guestImageReferences } from "./evidence-pattern"
import {
  checkGuestFileError,
  guestFileErrors,
  WorkspacePathError,
  workspaceError,
  workspacePath,
} from "./workspace-path"

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024
export const imageMime = (bytes: Uint8Array): string | null => {
  const b = Buffer.from(bytes)
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png"
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg"
  if (["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("ascii"))) return "image/gif"
  if (b.length >= 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP")
    return "image/webp"
  return null
}

export const imagePath = (root: string, path: string, base = ""): string => {
  if (!path || path.length > 4096 || /[\\\0]/.test(path) || [...path.split("/"), ...base.split("/")].includes(".."))
    throw new Error("Caminho inválido")
  if (isAbsolute(base)) throw new Error("Diretório relativo esperado")
  const suffix = relative(resolve(root), isAbsolute(path) ? path : resolve(root, base, path))
  if (!suffix || suffix === ".." || suffix.startsWith("../") || isAbsolute(suffix))
    throw new Error("Imagem fora do workspace")
  return suffix
}

/** Keep the fd pinned until EOF/cancel; never reopen a checked pathname. */
export const localImage = (root: string, path: string) => {
  const directory = openWorkspaceDirectory({ root, path: dirname(path) === "." ? "" : dirname(path) })
  let fd: number
  try {
    fd = openWorkspaceEntry(directory, path.split("/").at(-1) ?? "")
  } finally {
    closeSync(directory)
  }
  let closed = false
  const close = () => {
    if (!closed) {
      closed = true
      closeSync(fd)
    }
  }
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error("Escolha uma imagem de até 15 MB")
    const header = Buffer.alloc(12)
    const mime = imageMime(header.subarray(0, readSync(fd, header, 0, header.length, 0)))
    if (!mime) throw new Error("Formato de imagem inválido")
    let offset = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        try {
          if (offset >= info.size) {
            close()
            controller.close()
            return
          }
          const chunk = Buffer.alloc(Math.min(64 * 1024, info.size - offset))
          const count = readSync(fd, chunk, 0, chunk.length, offset)
          if (!count) {
            close()
            controller.close()
            return
          }
          offset += count
          controller.enqueue(chunk.subarray(0, count))
        } catch (error) {
          close()
          controller.error(error)
        }
      },
      cancel: close,
    })
    return { status: 200, stream, mime }
  } catch (error) {
    close()
    throw error
  }
}

// No shell interpolation, no symlink following at any component, bounded regular-file read.
export const guestImage = guestFileErrors(`import os,sys,stat,base64,json
parts=sys.argv[1].split('/')
if any(p in ('..','') or '\\\\' in p for p in parts): raise Exception('Caminho inválido')
fd=os.open(sys.argv[3] if len(sys.argv)>3 else '/workspace',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 for part in parts[:-1]:
  child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
  os.close(fd)
  fd=child
 item=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
 with os.fdopen(item,'rb') as f:
  info=os.fstat(f.fileno())
  if not stat.S_ISREG(info.st_mode) or info.st_size>15728640: raise Exception('Imagem acima de 15 MB')
  f.seek(int(sys.argv[2]))
  data=f.read(393216)
 print(json.dumps(dict(size=info.st_size,data=base64.b64encode(data).decode())))
finally: os.close(fd)`)

export const evidenceImageRoute = (kernel: Kernel, vm: VmRuntime): RouteModule["routes"][number] => ({
  method: "GET",
  path: "/bots/:id/images",
  handler: async ({ params, query, signal: requestSignal }) => {
    const bot = kernel.services.use("store.api")?.getBot({ botId: params.id ?? "" })
    if (!bot || bot.archivedAt) return { status: 404, json: { error: "Bot não encontrado" } }
    try {
      const db = kernel.db as Database
      const attachment = query.attachmentId
        ? (db.query("SELECT id,path FROM attachments WHERE id = ?").get(query.attachmentId) as {
            id: string
            path: string
          } | null)
        : query.path
          ? (db
              .query(`WITH candidates AS MATERIALIZED (
              SELECT id,path FROM attachments WHERE path = ?
              UNION ALL SELECT id,path FROM attachments WHERE origin_path = ? LIMIT 64
            ) SELECT a.id,a.path FROM candidates a WHERE EXISTS (
              SELECT 1 FROM attachment_message_refs refs JOIN threads t ON t.id = refs.thread_id
              WHERE refs.attachment_id = a.id AND t.bot_id = ?
            ) LIMIT 1`)
              .get(query.path, query.path, bot.id) as { id: string; path: string } | null)
          : null
      if (query.attachmentId && !attachment) return { status: 404, json: { error: "Anexo não encontrado" } }
      if (attachment) {
        const owned = db
          .query(`SELECT 1 FROM attachment_message_refs refs JOIN threads t ON t.id = refs.thread_id
          WHERE t.bot_id = ? AND refs.attachment_id = ? LIMIT 1`)
          .get(bot.id, attachment.id)
        if (!owned) return { status: 404, json: { error: "Anexo não encontrado para este bot" } }
        return getImageResponse(
          await getLocalImageAsync({
            root: kernel.paths.attachmentsDir,
            path: imagePath(kernel.paths.attachmentsDir, attachment.path),
          }),
        )
      }
      if (!query.path) throw new WorkspacePathError(400)
      if (bot.machine !== "vm" && bot.machine !== "cloud") {
        const project = bot.projectId
          ? (db.query("SELECT path FROM projects WHERE id = ? AND archived_at IS NULL").get(bot.projectId) as {
              path: string
            } | null)
          : null
        const result = await getWorkspaceImageAsync({
          appData: kernel.paths.appData,
          bot,
          path: query.path,
          base: query.base,
          projectPath: project?.path,
        })
        if (!("bytes" in result)) throw new WorkspacePathError(400)
        requestSignal.throwIfAborted()

        return getImageResponse(result)
      }
      const { root, path } = workspacePath(kernel, { ...bot, anyFolderAccess: false }, query.path, query.base)
      if (!path || /[?*[\]{}]/.test(path)) throw new WorkspacePathError(400)
      if (!vm.states().some((state) => state.botId === bot.id && state.status === "running"))
        return {
          status: 409,
          json: { errorCode: "IMAGE_MACHINE_STOPPED", error: "Imagem disponível quando a máquina estiver ligada" },
        }
      const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(30_000)])
      const release = await vm.acquire({ botId: bot.id, runningOnly: true, signal })
      let released = false
      const finish = async () => {
        if (!released) {
          released = true
          await release()
        }
      }
      const read = async (offset: number) => {
        const result = await vm.exec({
          botId: bot.id,
          command: "python3",
          args: ["-c", guestImage, path, String(offset), root],
          signal,
        })
        if (!result.success || result.stdout.length > 530_000) throw new Error("Imagem indisponível")
        checkGuestFileError(result.stdout)
        const chunk = JSON.parse(result.stdout) as { size: number; data: string }
        if (
          !Number.isSafeInteger(chunk.size) ||
          chunk.size < 1 ||
          chunk.size > MAX_IMAGE_BYTES ||
          typeof chunk.data !== "string"
        )
          throw new Error("Imagem inválida")
        const bytes = Buffer.from(chunk.data, "base64")
        if (!bytes.length || bytes.length > 393216 || offset + bytes.length > chunk.size)
          throw new Error("Bloco inválido")
        return { size: chunk.size, bytes }
      }
      try {
        const first = await read(0)
        const mime = imageMime(first.bytes)
        if (!mime) throw new Error("Formato de imagem inválido")
        let offset = 0
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              if (offset >= first.size) {
                await finish()
                controller.close()
                return
              }
              const chunk = offset === 0 ? first : await read(offset)
              if (chunk.size !== first.size) throw new Error("Imagem alterada durante a leitura")
              offset += chunk.bytes.length
              controller.enqueue(chunk.bytes)
            } catch (error) {
              await finish()
              controller.error(error)
            }
          },
          cancel: finish,
        })
        return { status: 200, mime, stream }
      } catch (error) {
        await finish()
        throw error
      }
    } catch (error) {
      return workspaceError(error)
    }
  },
})

const getImageResponse = ({ bytes, mime }: { bytes: Uint8Array; mime: string }): RouteResponse => ({
  status: 200,
  mime,
  stream: new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  }),
})

export const evidenceReferencesRoute = (kernel: Kernel, vm: VmRuntime): RouteModule["routes"][number] => ({
  method: "GET",
  path: "/bots/:id/image-references",
  handler: async ({ params, query, signal }) => {
    const bot = kernel.services.use("store.api")?.getBot({ botId: params.id ?? "" })
    if (!bot || bot.archivedAt) return { status: 404, json: { error: "Bot não encontrado" } }
    if (!query.path?.includes("*")) return { status: 400, json: { error: "Padrão inválido" } }
    const project = bot.projectId
      ? ((kernel.db as Database)
          .query("SELECT path FROM projects WHERE id = ? AND archived_at IS NULL")
          .get(bot.projectId) as { path: string } | null)
      : null
    try {
      signal.throwIfAborted()
      if (bot.machine === "vm" || bot.machine === "cloud")
        return await getGuestImageReferenceResponse(kernel, vm, bot, query.path, query.base, signal)
      const result = await getWorkspaceImageAsync({
        appData: kernel.paths.appData,
        bot,
        projectPath: project?.path,
        path: query.path,
        base: query.base,
        pattern: true,
      })
      signal.throwIfAborted()

      return { status: 200, json: "paths" in result ? result : { paths: [] } }
    } catch (error) {
      return workspaceError(error)
    }
  },
})

const getGuestImageReferenceResponse = async (
  kernel: Kernel,
  vm: VmRuntime,
  bot: Bot,
  source: string,
  base: string | undefined,
  signal: AbortSignal,
): Promise<RouteResponse> => {
  const pattern = getImagePattern(source)
  const { root, path } = workspacePath(
    kernel,
    Object.assign({}, bot, { anyFolderAccess: false }),
    dirname(source),
    base,
  )
  if (!vm.states().some((state) => state.botId === bot.id && state.status === "running"))
    return { status: 200, json: { paths: [] } }
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
  const release = await vm.acquire({ botId: bot.id, runningOnly: true, signal: deadline })
  try {
    const result = await vm.exec({
      botId: bot.id,
      command: "python3",
      args: ["-c", guestImageReferences, root, path, pattern.prefix, pattern.suffix],
      signal: deadline,
    })
    if (!result.success) throw new WorkspacePathError(404)
    if (result.stdout.length > 8192) throw new WorkspacePathError(400)
    checkGuestFileError(result.stdout)
    const parsed = (JSON.parse(result.stdout) as { names?: unknown }).names
    if (!Array.isArray(parsed) || parsed.length > 6 || !parsed.every(isGuestImageName))
      throw new WorkspacePathError(400)
    const names = parsed.filter(
      (name) => name.toLowerCase().startsWith(pattern.prefix) && name.toLowerCase().endsWith(pattern.suffix),
    )

    return { status: 200, json: { paths: names.map((name) => join(dirname(source), name)) } }
  } finally {
    await release()
  }
}

const isGuestImageName = (name: unknown): name is string =>
  typeof name === "string" && name.length <= 255 && !/[/\\\0]/.test(name) && name !== "." && name !== ".."
