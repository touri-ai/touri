import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"

const siteDir = join(import.meta.dirname, "site")
const routes: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/s/chicago": { file: "results.html", type: "text/html; charset=utf-8" },
  "/entrar": { file: "login.html", type: "text/html; charset=utf-8" },
  "/final": { file: "final.html", type: "text/html; charset=utf-8" },
  "/site.css": { file: "site.css", type: "text/css; charset=utf-8" },
}

export type FixtureSite = { url: string; close: () => Promise<void> }

// Serves the disposable travel site on a loopback port; nothing leaves the machine.
export const startFixtureSite = async (): Promise<FixtureSite> => {
  const server = createServer(async (request, response) => {
    const route = routes[new URL(request.url ?? "/", "http://fixture.local").pathname]
    if (!route) {
      response.writeHead(404).end("not found")
      return
    }
    response.writeHead(200, { "content-type": route.type, "cache-control": "no-store" })
    response.end(await readFile(join(siteDir, route.file)))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
