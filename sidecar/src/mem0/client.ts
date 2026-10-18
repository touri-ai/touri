import type { Mem0Mode } from "@touri/contracts"

export const PLATFORM_URL = "https://api.mem0.ai"
export const SEARCH_TIMEOUT_MS = 3_000
export const WRITE_TIMEOUT_MS = 10_000

export type Mem0Memory = {
  id: string
  memory: string
  score: number | null
  userId: string | null
  agentId: string | null
}
export type Mem0Scope = { userId: string; agentId?: string }
export type Mem0Message = { role: "user" | "assistant"; content: string }

/** A failed call. `notFound` is the caller's mistake (wrong id), not an outage, so it never trips the breaker. */
export class Mem0Error extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly reason: "unavailable" | "timeout" | "invalid_response" = "unavailable",
  ) {
    super(message)
  }
  get notFound(): boolean {
    return this.status === 404
  }
}

export type Mem0Client = {
  search: (args: { query: string; scope: Mem0Scope; topK: number; threshold: number }) => Promise<Mem0Memory[]>
  add: (args: {
    messages: Mem0Message[]
    scope: Mem0Scope
    infer: boolean
    metadata: Record<string, string>
  }) => Promise<void>
  get: (id: string) => Promise<Mem0Memory>
  update: (id: string, text: string) => Promise<void>
  remove: (id: string) => Promise<void>
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null)

const toMemory = (value: unknown): Mem0Memory | null => {
  if (!value || typeof value !== "object") return null
  const row = value as Record<string, unknown>
  const id = text(row.id)
  const memory = text(row.memory) ?? text(row.text) ?? text(row.data)
  if (!id || memory === null) return null
  return {
    id,
    memory,
    score: typeof row.score === "number" ? row.score : null,
    userId: text(row.user_id),
    agentId: text(row.agent_id),
  }
}

const results = (body: unknown): Mem0Memory[] => {
  const list = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { results?: unknown }).results)
      ? (body as { results: unknown[] }).results
      : null
  if (!list) throw new Mem0Error("Mem0 returned an invalid search response", null, "invalid_response")
  return list.flatMap((row) => {
    const memory = toMemory(row)
    return memory ? [memory] : []
  })
}

/** Platform v3 takes entity ids inside `filters`; several ids must be combined explicitly. */
const platformFilters = (scope: Mem0Scope): Record<string, unknown> =>
  scope.agentId ? { AND: [{ user_id: scope.userId }, { agent_id: scope.agentId }] } : { user_id: scope.userId }

const serverFilters = (scope: Mem0Scope): Record<string, unknown> => ({
  user_id: scope.userId,
  ...(scope.agentId ? { agent_id: scope.agentId } : {}),
})

const validId = (id: string): boolean => /^[A-Za-z0-9_-]{1,128}$/.test(id)

/**
 * Talks to Mem0 Cloud (platform v3) or to a self-hosted Mem0 server with plain fetch.
 * Both answer with the same normalized shape. The key is sent only in the auth header.
 */
export const createMem0Client = ({
  mode,
  url,
  apiKey,
  platformUrl = PLATFORM_URL,
  fetchImpl = fetch,
  signal,
}: {
  mode: Mem0Mode
  /** The self-hosted server; platform mode ignores it so the key only ever goes to Mem0 Cloud. */
  url: string
  apiKey: string
  platformUrl?: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}): Mem0Client => {
  const base = (mode === "platform" ? platformUrl : url).replace(/\/+$/, "")
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(mode === "platform" ? { Authorization: `Token ${apiKey}` } : apiKey ? { "X-API-Key": apiKey } : {}),
  }
  const call = async (method: string, path: string, body: unknown, timeoutMs: number): Promise<unknown> => {
    if (!base) throw new Mem0Error("Mem0 server URL is not configured", null)
    let response: Response
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
        redirect: "error",
      })
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
      throw new Mem0Error(
        timedOut ? "Mem0 did not answer in time" : "Mem0 is unreachable",
        null,
        timedOut ? "timeout" : "unavailable",
      )
    }
    if (!response.ok) {
      // The body may echo request content; keep only the status.
      await response.body?.cancel().catch(() => undefined)
      throw new Mem0Error(`Mem0 answered HTTP ${response.status}`, response.status)
    }
    if (response.status === 204) return null
    try {
      return await response.json()
    } catch {
      throw new Mem0Error("Mem0 returned an invalid response", null, "invalid_response")
    }
  }
  const item = (id: string) => {
    if (!validId(id)) throw new Mem0Error("Invalid memory id", 404)
    return mode === "platform" ? `/v1/memories/${id}/` : `/memories/${id}`
  }
  return {
    search: async ({ query, scope, topK, threshold }) =>
      results(
        await call(
          "POST",
          mode === "platform" ? "/v3/memories/search/" : "/search",
          {
            query,
            filters: mode === "platform" ? platformFilters(scope) : serverFilters(scope),
            top_k: topK,
            threshold,
          },
          SEARCH_TIMEOUT_MS,
        ),
      ),
    add: async ({ messages, scope, infer, metadata }) => {
      await call(
        "POST",
        mode === "platform" ? "/v3/memories/add/" : "/memories",
        {
          messages,
          user_id: scope.userId,
          ...(scope.agentId ? { agent_id: scope.agentId } : {}),
          metadata,
          infer,
        },
        WRITE_TIMEOUT_MS,
      )
    },
    get: async (id) => {
      const memory = toMemory(await call("GET", item(id), undefined, SEARCH_TIMEOUT_MS))
      if (!memory) throw new Mem0Error("Memory not found", 404)
      return memory
    },
    update: async (id, value) => {
      await call("PUT", item(id), { text: value }, WRITE_TIMEOUT_MS)
    },
    remove: async (id) => {
      await call("DELETE", item(id), undefined, WRITE_TIMEOUT_MS)
    },
  }
}

/**
 * Pauses calls for one bot after repeated failures, so an outage costs one short wait
 * instead of a slow turn every time. Not-found answers do not count.
 */
export const createBreaker = ({ failures = 5, pauseMs = 120_000, now = Date.now } = {}) => {
  const state = new Map<string, { count: number; openUntil: number }>()
  return {
    open: (key: string): boolean => (state.get(key)?.openUntil ?? 0) > now(),
    success: (key: string): void => {
      state.delete(key)
    },
    failure: (key: string, error: unknown): void => {
      if (error instanceof Mem0Error && error.notFound) return
      const current = state.get(key) ?? { count: 0, openUntil: 0 }
      const count = current.count + 1
      state.set(key, count >= failures ? { count: 0, openUntil: now() + pauseMs } : { count, openUntil: 0 })
    },
    reset: (key: string): void => {
      state.delete(key)
    },
  }
}
