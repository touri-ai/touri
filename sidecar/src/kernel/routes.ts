import type { HttpMethod, RouteModule, RouteRequest, RouteResponse } from "@touri/contracts"
import { errorResponse, normalizeErrorBody } from "./errors"

type Route = { method: HttpMethod; path: string; handler: (req: RouteRequest) => Promise<RouteResponse> }

const split = (value: string): Array<string> => value.split("/").filter((part) => part.length > 0)

const match = (pattern: string, pathname: string): Record<string, string> | null => {
  const expected = split(pattern)
  const actual = split(pathname)
  if (expected.length !== actual.length) return null
  const params: Record<string, string> = {}
  for (let index = 0; index < expected.length; index += 1) {
    const routePart = expected[index]
    const actualPart = actual[index]
    if (!routePart || actualPart === undefined) return null
    if (routePart.startsWith(":")) params[routePart.slice(1)] = decodeURIComponent(actualPart)
    else if (routePart !== actualPart) return null
  }
  return params
}

export const createRouteRegistry = (onError?: (code: string) => void) => {
  const observe = (response: RouteResponse): RouteResponse => {
    if (
      response.status >= 400 &&
      "json" in response &&
      response.json &&
      typeof response.json === "object" &&
      "code" in response.json &&
      typeof response.json.code === "string"
    )
      onError?.(response.json.code)
    return response
  }
  let routes: Array<Route & { parts: Array<string> }> = []
  const registerRoutes = (module: RouteModule): void => {
    const additions = module.routes.filter((route, index) => {
      if (routes.some((candidate) => candidate.method === route.method && candidate.path === route.path)) return false

      return (
        module.routes.findIndex((candidate) => candidate.method === route.method && candidate.path === route.path) ===
        index
      )
    })

    routes = [...routes, ...additions.map((route) => ({ ...route, parts: split(route.path) }))]
  }

  const getTemplate = (method: string, pathname: string): string | undefined => {
    const actual = split(pathname)

    return routes.find((route) => {
      if (route.method !== method) return false

      const expected = route.parts
      return (
        expected.length === actual.length &&
        expected.every((part, index) => part.startsWith(":") || part === actual[index])
      )
    })?.path
  }

  const handle = async ({
    method,
    pathname,
    query,
    body,
    signal,
  }: {
    method: string
    pathname: string
    query: URLSearchParams
    body: unknown
    signal: AbortSignal
  }): Promise<RouteResponse> => {
    const normalizedMethod = method.toUpperCase() as HttpMethod
    for (const route of routes) {
      let params: Record<string, string> | null
      try {
        params = match(route.path, pathname)
      } catch {
        return { status: 400, json: normalizeErrorBody({ errorCode: "INVALID_ARGS" }, 400) }
      }
      if (route.method === normalizedMethod && params) {
        const queryRecord: Record<string, string> = {}
        for (const [key, value] of query.entries()) queryRecord[key] = value
        try {
          const response = await route.handler({ params, query: queryRecord, body, signal })
          return observe(
            "json" in response ? { ...response, json: normalizeErrorBody(response.json, response.status) } : response,
          )
        } catch (error) {
          return observe(errorResponse(error))
        }
      }
    }
    return { status: 404, json: normalizeErrorBody({ errorCode: "NOT_FOUND" }, 404) }
  }

  return { registerRoutes, getTemplate, handle }
}
