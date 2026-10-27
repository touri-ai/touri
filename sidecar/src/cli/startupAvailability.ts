import type { WebInterceptArgs } from "../kernel"

type Intercept = (args: WebInterceptArgs) => Promise<Response | null>

/** Keep recovery clients from flushing their outbox before the API modules have registered. */
export const createStartupAvailability = (intercept: Intercept) => {
  let ready = false
  let draining = false

  return {
    intercept: async (args: WebInterceptArgs): Promise<Response | null> => {
      if (args.url.pathname === "/readyz") {
        // Reuse the public liveness boundary for transport checks without any store access.
        const url = new URL(args.url)
        url.pathname = "/healthz"
        const response = await intercept({ ...args, url })
        if (response?.status !== 200) return response

        return new Response(args.request.method === "HEAD" ? null : JSON.stringify({ ok: ready && !draining }), {
          status: ready && !draining ? 200 : 503,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        })
      }
      if (ready || !args.url.pathname.startsWith("/api/")) return intercept(args)

      return Response.json(
        { code: "TOURI-E1009", errorCode: "SERVER_CONNECTION_FAILED" },
        { status: 503, headers: { "Retry-After": "1", "Cache-Control": "no-store" } },
      )
    },
    markReady: (): void => {
      ready = true
    },
    beginDrain: (): void => {
      draining = true
    },
  }
}
