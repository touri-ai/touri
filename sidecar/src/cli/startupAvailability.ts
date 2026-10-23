import type { WebInterceptArgs } from "../kernel"

type Intercept = (args: WebInterceptArgs) => Promise<Response | null>

/** Keep recovery clients from flushing their outbox before the API modules have registered. */
export const createStartupAvailability = (intercept: Intercept) => {
  let ready = false

  return {
    intercept: async (args: WebInterceptArgs): Promise<Response | null> => {
      if (ready || !args.url.pathname.startsWith("/api/")) return intercept(args)

      return Response.json(
        { code: "TOURI-E1009", errorCode: "SERVER_CONNECTION_FAILED" },
        { status: 503, headers: { "Retry-After": "1", "Cache-Control": "no-store" } },
      )
    },
    markReady: (): void => {
      ready = true
    },
  }
}
