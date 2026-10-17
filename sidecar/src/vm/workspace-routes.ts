import { randomBytes } from "node:crypto"
import { closeSync, fstatSync, readSync } from "node:fs"
import { readdir, realpath } from "node:fs/promises"
import { basename, resolve } from "node:path"
import type { Kernel, RouteModule, VmRuntime, WorkspaceFile } from "@touri/contracts"

import { openWorkspaceDirectory, openWorkspaceEntry } from "../kernel/files"
import { evidenceImageRoute } from "./evidence-images"
import { cancelGuestShell, guestShell } from "./guest-shell"
import {
  checkGuestFileError,
  guestFileErrors,
  WorkspacePathError,
  workspaceError,
  workspacePath,
} from "./workspace-path"

const MAX_BYTES = 524_288
const validPath = (path: string) =>
  path.length < 4096 &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  path.split("/").every((part) => part === "" || (!part.startsWith(".") && part !== ".."))
const mimeFor = (name: string) => Bun.file(name).type || "application/octet-stream"

// The guest reads as its regular user. Paths are arguments, never shell interpolation.
const guestFiles = guestFileErrors(`import os,sys,json,base64,mimetypes,stat
path=sys.argv[2]
parts=[p for p in path.split('/') if p]
if any(p.startswith('.') for p in parts): raise Exception('Caminho inválido')
fd=os.open(sys.argv[3],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 for part in (parts if sys.argv[1]=='list' else parts[:-1]):
  child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
  os.close(fd)
  fd=child
 if sys.argv[1]=='list':
  result=[]
  for entry in sorted(os.scandir(fd),key=lambda e:(not e.is_dir(follow_symlinks=False),e.name.lower())):
   if entry.name.startswith('.') or entry.name=='node_modules' or entry.is_symlink(): continue
   if not entry.is_dir(follow_symlinks=False) and not entry.is_file(follow_symlinks=False): continue
   result.append(dict(name=entry.name,path=os.path.join(path,entry.name),directory=entry.is_dir(follow_symlinks=False),bytes=entry.stat(follow_symlinks=False).st_size))
   if len(result)>=500: break
  print(json.dumps(dict(files=result)))
 else:
  item=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
  with os.fdopen(item,'rb') as f:
   if not stat.S_ISREG(os.fstat(f.fileno()).st_mode): raise Exception('Escolha um arquivo regular')
   data=f.read(524289)
  if len(data)>524288: raise Exception('Arquivo acima de 512 KiB')
  print(json.dumps(dict(name=parts[-1],mime=mimetypes.guess_type(parts[-1])[0] or 'application/octet-stream',base64=base64.b64encode(data).decode())))
finally: os.close(fd)`)

const localFiles = async (path: string, content: boolean, rootPath: string) => {
  const parts = path.split("/").filter(Boolean)
  const name = content ? parts.pop() : undefined
  const directory = openWorkspaceDirectory({ root: "/", path: [rootPath.slice(1), ...parts].filter(Boolean).join("/") })
  // Listing names may race with a rename; only entries opened under the pinned fd are returned.
  try {
    if (!content) {
      const entries = await readdir(resolve(await realpath(rootPath), path), { withFileTypes: true })
      const files: WorkspaceFile[] = []
      for (const entry of entries.sort(
        (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
      )) {
        if (entry.name.startsWith(".") || entry.name === "node_modules" || (!entry.isDirectory() && !entry.isFile()))
          continue
        let item: number
        try {
          item = openWorkspaceEntry(directory, entry.name)
        } catch {
          continue
        }
        try {
          const info = fstatSync(item)
          if (info.isDirectory() || info.isFile())
            files.push({
              name: entry.name,
              path: path ? `${path}/${entry.name}` : entry.name,
              directory: info.isDirectory(),
              bytes: info.size,
            })
        } finally {
          closeSync(item)
        }
        if (files.length >= 500) break
      }
      return { files }
    }
    const file = openWorkspaceEntry(directory, name ?? "")
    try {
      const info = fstatSync(file)
      if (!info.isFile() || info.size > MAX_BYTES) throw new Error("Escolha um arquivo de até 512 KiB")
      const bytes = Buffer.alloc(MAX_BYTES + 1)
      let offset = 0
      while (offset < bytes.length) {
        const bytesRead = readSync(file, bytes, offset, bytes.length - offset, offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      if (offset > MAX_BYTES) throw new Error("Arquivo acima de 512 KiB")
      return {
        name: basename(name ?? path),
        mime: mimeFor(name ?? path),
        base64: bytes.subarray(0, offset).toString("base64"),
      }
    } finally {
      closeSync(file)
    }
  } finally {
    closeSync(directory)
  }
}

export const botWorkspaceRoutes = (kernel: Kernel, vm: VmRuntime): RouteModule["routes"] => {
  const shells = new Map<string, AbortController>()
  const stopShells = () => {
    for (const controller of shells.values()) controller.abort()
  }
  kernel.services.provide("vm.stopShells", stopShells)
  kernel.subscribe(({ event }) => {
    if (
      event.type === "bot.updated" &&
      (!event.bot.computerUse || event.bot.access === "read-only" || event.bot.paused || event.bot.machine !== "vm")
    )
      shells.get(event.bot.id)?.abort()
  })
  kernel.onHostNotification(({ method }) => {
    if (method === "computer.killSwitch" || method === "app.willQuit") stopShells()
  })
  return [
    evidenceImageRoute(kernel, vm),
    ...[false, true].map((content): RouteModule["routes"][number] => ({
      method: "GET",
      path: content ? "/bots/:id/files/content" : "/bots/:id/files",
      handler: async ({ params, query }) => {
        const bot = kernel.services.use("store.api")?.getBot({ botId: params.id ?? "" })
        if (!bot || bot.archivedAt) return { status: 404, json: { error: "Bot não encontrado" } }
        try {
          const input = query.path ?? ""
          if (input.split("/").includes(".") || (content && !input)) throw new WorkspacePathError(400)
          const { root, path } = workspacePath(kernel, bot, input)
          if (!validPath(path) || (content && !path)) throw new WorkspacePathError(400)
          if (bot.machine !== "vm" && bot.machine !== "cloud") {
            const result = await localFiles(path, content, root)
            if (input.startsWith("/") && "files" in result)
              result.files = result.files.map((entry) => ({ ...entry, path: resolve(root, entry.path) }))
            return { status: 200, json: result }
          }
          if (!vm.states().some((state) => state.botId === bot.id && state.status === "running"))
            return {
              status: 409,
              json: {
                errorCode: "IMAGE_MACHINE_STOPPED",
                error: "Arquivos disponíveis quando a máquina estiver ligada",
              },
            }
          const signal = AbortSignal.timeout(30_000)
          const release = await vm.acquire({ botId: bot.id, signal, runningOnly: true })
          try {
            const result = await vm.exec({
              botId: bot.id,
              command: "python3",
              args: ["-c", guestFiles, content ? "read" : "list", path, root],
              signal,
            })
            if (!result.success) throw new Error(result.error)
            checkGuestFileError(result.stdout)
            const response = JSON.parse(result.stdout) as { files?: WorkspaceFile[] }
            if (input.startsWith("/") && response.files)
              response.files = response.files.map((entry) => ({ ...entry, path: resolve(root, entry.path) }))
            return { status: 200, json: response }
          } finally {
            await release()
          }
        } catch (error) {
          return workspaceError(error)
        }
      },
    })),
    {
      method: "POST",
      path: "/bots/:id/machine/shell",
      handler: async ({ params, body }) => {
        const bot = kernel.services.use("store.api")?.getBot({ botId: params.id ?? "" })
        if (!bot || bot.archivedAt) return { status: 404, json: { error: "Bot não encontrado" } }
        if (bot.machine === "local" || !bot.computerUse || bot.access === "read-only" || bot.paused)
          return {
            status: 403,
            json: {
              error: "O terminal requer uma VM, controle do computador e acesso de escrita habilitados para este bot",
            },
          }
        const command = (body as { command?: unknown } | null)?.command
        if (typeof command !== "string" || !command.trim() || command.length > 4096)
          return { status: 400, json: { error: "Digite um comando de até 4096 caracteres" } }
        if (bot.machine === "cloud") {
          const result = await vm.exec({
            botId: bot.id,
            command: "/bin/sh",
            args: ["-lc", command],
            cwd: "/workspace",
            signal: AbortSignal.timeout(30_000),
          })
          if (!result.success) return { status: 503, json: { errorCode: result.errorCode } }
          return {
            status: 200,
            json: { stdout: result.stdout.slice(0, 65_536), stderr: result.stderr.slice(0, 65_536), code: result.code },
          }
        }
        if (shells.has(bot.id)) return { status: 409, json: { error: "Já há um comando em andamento" } }
        const controller = new AbortController()
        shells.set(bot.id, controller)
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])
        const marker = `/tmp/touri-shell-${randomBytes(16).toString("hex")}`
        let release: (() => Promise<void>) | undefined
        try {
          release = await vm.acquire({ botId: bot.id, signal })
          const result = await vm.exec({
            botId: bot.id,
            command: "python3",
            args: ["-c", guestShell, marker, command],
            signal,
          })
          if (!result.success) throw new Error(result.error)
          const output = JSON.parse(result.stdout) as { stdout: string; stderr: string; code: number }
          return {
            status: 200,
            json: {
              stdout: Buffer.from(output.stdout).subarray(0, 65_536).toString("utf8"),
              stderr: Buffer.from(output.stderr).subarray(0, 65_536).toString("utf8"),
              code: output.code,
            },
          }
        } catch (error) {
          return {
            status: 422,
            json: { error: kernel.redact(error instanceof Error ? error.message : "Comando interrompido") },
          }
        } finally {
          if (release && signal.aborted) {
            await vm
              .exec({
                botId: bot.id,
                command: "python3",
                args: ["-c", cancelGuestShell, marker],
                signal: AbortSignal.timeout(3000),
              })
              .catch(() => undefined)
          }
          shells.delete(bot.id)
          await release?.()
        }
      },
    },
  ]
}
