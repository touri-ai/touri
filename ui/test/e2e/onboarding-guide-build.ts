import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { extname, join, resolve, sep } from "node:path"
import { build } from "vite"

export const createGuideBuild = async (
  entry: "guide" | "legacy",
  sources: { path: string; source: string }[] = [],
  browser = "browser",
) => {
  const root = resolve(import.meta.dirname, "../../..")
  const cache = join(root, "node_modules/.cache")
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, `onboarding-${entry}-${browser}-`))
  const page = `test/e2e/onboarding-${entry}-harness.html`
  await build({
    root: join(root, "ui"),
    configFile: join(root, "ui/vite.config.ts"),
    logLevel: "error",
    build: { outDir: directory, rollupOptions: { input: join(root, "ui", page) } },
    plugins: [
      {
        name: "onboarding-review-sources",
        enforce: "pre",
        transform: (_source, id) => sources.find((source) => source.path === id)?.source,
      },
    ],
  }).catch(async (error: unknown) => {
    await rm(directory, { recursive: true, force: true })
    throw error
  })
  const server = createBuildServer(directory)
  const port = await listen(server).catch(async (error: unknown) => {
    await rm(directory, { recursive: true, force: true })
    throw error
  })
  return {
    url: `http://127.0.0.1:${port}/${page}`,
    stop: async () => {
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
      await rm(directory, { recursive: true, force: true })
    },
  }
}

const createBuildServer = (directory: string) =>
  createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname
    const file = resolve(directory, `.${path}`)
    if (!file.startsWith(`${directory}${sep}`)) {
      response.writeHead(404).end()
      return
    }
    const types: Record<string, string> = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".woff2": "font/woff2",
      ".png": "image/png",
      ".svg": "image/svg+xml",
    }
    try {
      const bytes = await readFile(file)
      response.writeHead(200, { "Content-Type": types[extname(file)] ?? "text/plain" }).end(bytes)
    } catch {
      response.writeHead(404).end()
    }
  })

const listen = async (server: Server): Promise<number> => {
  for (const port of Array.from({ length: 100 }, (_, index) => 18800 + index)) {
    const accepted = await new Promise<boolean>((done) => {
      const fail = () => done(false)
      server.once("error", fail)
      server.listen(port, "127.0.0.1", () => {
        server.off("error", fail)
        done(true)
      })
    })
    if (accepted) return port
  }
  throw new Error("No available staging port")
}
