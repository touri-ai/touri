import type { KernelSocketData, WebMode } from "../kernel"

/** Own the same port from liveness through API registration, without bypassing web authentication. */
export const startStartupListener = (hostname: string, port: number, intercept: WebMode["intercept"]) => {
  const server = Bun.serve<KernelSocketData>({
    hostname,
    port,
    fetch: async (request, server) =>
      (await intercept({ request, url: new URL(request.url), clientIp: server.requestIP(request)?.address ?? null })) ??
      new Response(null, { status: 503, headers: { "Retry-After": "1", "Cache-Control": "no-store" } }),
    websocket: { message: () => {} },
  })

  return {
    listen: (options: Bun.Serve.Options<KernelSocketData>) => server.reload(options),
    stop: () => server.stop(true),
  }
}
