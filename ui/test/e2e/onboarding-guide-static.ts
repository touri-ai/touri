import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { extname, resolve, sep } from "node:path"

/** A disposable loopback server for the production browser fixture; API traffic is route-mocked. */
export const createGuideStaticServer = async () => {
  const directory = resolve(import.meta.dirname, "../../dist")
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname
    const file = resolve(directory, `.${pathname}`)
    if (!file.startsWith(`${directory}${sep}`)) {
      response.writeHead(404).end()
      return
    }
    try {
      const content = await readFile(file)
      response.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" })
      response.end(content)
    } catch {
      response.writeHead(404).end()
    }
  })
  const port = await listen(server)
  return {
    url: `http://127.0.0.1:${port}`,
    dispose: async () => {
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}
const types: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
}
const listen = async (server: ReturnType<typeof createServer>): Promise<number> => {
  for (const port of Array.from({ length: 100 }, (_, index) => 18800 + index)) {
    const accepted = await new Promise<boolean>((done) => {
      const error = () => done(false)
      server.once("error", error)
      server.listen(port, "127.0.0.1", () => {
        server.off("error", error)
        done(true)
      })
    })
    if (accepted) return port
  }
  throw new Error("No available staging port")
}
