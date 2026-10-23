import type { CdpClient, CdpEvent, CdpPipe, JsonObject } from "./types"

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type CdpMessage = {
  id?: number
  method?: string
  params?: JsonObject
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
  sessionId?: string
}

const asMessage = (value: unknown): CdpMessage | null => {
  if (typeof value !== "object" || value === null) return null
  return value as CdpMessage
}

const asError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)))

const joinBytes = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const joined = new Uint8Array(left.length + right.length)
  joined.set(left)
  joined.set(right, left.length)
  return joined
}

const frame = (value: string): Uint8Array => {
  const body = new TextEncoder().encode(value)
  const output = new Uint8Array(body.length + 1)
  output.set(body)
  output[body.length] = 0
  return output
}

export const createCdpClient = ({ pipe, timeoutMs = 30000 }: { pipe: CdpPipe; timeoutMs?: number }): CdpClient => {
  const reader = pipe.read.getReader()
  const writer = pipe.write.getWriter()
  const pending = new Map<number, PendingRequest>()
  const listeners = new Set<(event: CdpEvent) => void>()
  const disconnectListeners = new Set<() => void>()
  let nextId = 1
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array()
  let closed = false
  let disposed = false
  let writeChain = Promise.resolve()

  const rejectAll = (reason: unknown): void => {
    const error = asError(reason)
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
  }

  const dispatch = (message: CdpMessage): void => {
    if (typeof message.id === "number") {
      const request = pending.get(message.id)
      if (!request) return
      pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.error) {
        const error = new Error(message.error.message ?? "Chrome DevTools Protocol error")
        request.reject(error)
        return
      }
      request.resolve(message.result)
      return
    }
    if (typeof message.method !== "string") return
    const event: CdpEvent = {
      method: message.method,
      params: message.params ?? {},
      ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }),
    }
    for (const listener of listeners) listener(event)
  }

  const readLoop = async (): Promise<void> => {
    try {
      while (!closed) {
        const result = await reader.read()
        if (result.done) throw new Error("Chrome debugging pipe closed")
        buffer = joinBytes(buffer, result.value)
        let separator = buffer.indexOf(0)
        while (separator >= 0) {
          if (separator > 32 * 1024 * 1024) throw new Error("Chrome debugging frame is too large")
          const body = buffer.slice(0, separator)
          buffer = buffer.slice(separator + 1)
          if (body.length > 0) dispatch(asMessage(JSON.parse(new TextDecoder().decode(body))) ?? {})
          separator = buffer.indexOf(0)
        }
        if (buffer.length > 32 * 1024 * 1024) throw new Error("Chrome debugging frame is too large")
      }
    } catch (error) {
      if (!closed) {
        closed = true
        rejectAll(error)
        for (const listener of disconnectListeners) listener()
        disconnectListeners.clear()
      }
    }
  }
  void readLoop()

  const call = <T>(method: string, params: JsonObject = {}, sessionId?: string): Promise<T> => {
    if (closed) return Promise.reject(new Error("Chrome debugging pipe is closed"))
    const id = nextId++
    const message: CdpMessage = {
      id,
      method,
      params,
      ...(sessionId === undefined ? {} : { sessionId }),
    }
    const payload = frame(JSON.stringify(message))
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP deadline exceeded for ${method}`))
      }, timeoutMs)
      pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
    })
    writeChain = writeChain
      .then(() => writer.write(payload))
      .catch((error: unknown) => {
        const request = pending.get(id)
        if (request) {
          pending.delete(id)
          clearTimeout(request.timer)
          request.reject(asError(error))
        }
      })
    return promise
  }

  const close = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    closed = true
    rejectAll(new Error("Chrome debugging pipe closed"))
    for (const listener of disconnectListeners) listener()
    disconnectListeners.clear()
    await reader.cancel().catch(() => undefined)
    await writer.close().catch(() => undefined)
    reader.releaseLock()
    writer.releaseLock()
    buffer = new Uint8Array()
    listeners.clear()
  }

  return {
    call,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close,
    isClosed: () => closed,
    onDisconnect: (listener) => {
      if (closed) listener()
      else disconnectListeners.add(listener)
      return () => disconnectListeners.delete(listener)
    },
  }
}

export const connectCdpWebSocket = async ({
  url,
  timeoutMs = 30000,
  connectTimeoutMs = timeoutMs,
  signal,
}: {
  url: string
  timeoutMs?: number
  connectTimeoutMs?: number
  signal?: AbortSignal
}): Promise<CdpClient> => {
  signal?.throwIfAborted()
  const socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      socket.removeEventListener("open", open)
      socket.removeEventListener("error", failed)
      socket.removeEventListener("close", failed)
    }
    const fail = (reason: unknown) => {
      cleanup()
      socket.close()
      reject(reason)
    }
    const open = () => {
      cleanup()
      resolve()
    }
    const failed = () => fail(new Error("Chrome WebSocket connection failed"))
    const abort = () => fail(signal?.reason)
    const timer = setTimeout(() => fail(new Error("Chrome WebSocket connection timed out")), connectTimeoutMs)
    socket.addEventListener("open", open, { once: true })
    socket.addEventListener("error", failed, { once: true })
    socket.addEventListener("close", failed, { once: true })
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
  })
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
  const listeners = new Set<(event: CdpEvent) => void>()
  const disconnectListeners = new Set<() => void>()
  let nextId = 1
  let closed = false
  socket.addEventListener("message", (event) => {
    const parsed = asMessage(
      JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)),
    )
    if (!parsed) return
    if (typeof parsed.id === "number") {
      const request = pending.get(parsed.id)
      if (!request) return
      pending.delete(parsed.id)
      clearTimeout(request.timer)
      if (parsed.error) request.reject(new Error(parsed.error.message ?? "Chrome DevTools Protocol error"))
      else request.resolve(parsed.result)
      return
    }
    if (typeof parsed.method !== "string") return
    const message: CdpEvent = {
      method: parsed.method,
      params: parsed.params ?? {},
      ...(parsed.sessionId === undefined ? {} : { sessionId: parsed.sessionId }),
    }
    for (const listener of listeners) listener(message)
  })
  const rejectAll = (error: Error): void => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
  }
  const disconnected = () => {
    if (closed) return
    closed = true
    rejectAll(new Error("Chrome WebSocket closed"))
    signal?.removeEventListener("abort", closeOnAbort)
    for (const listener of disconnectListeners) listener()
    disconnectListeners.clear()
    listeners.clear()
  }
  const closeOnAbort = () => {
    disconnected()
    socket.close()
  }
  socket.addEventListener("close", disconnected)
  socket.addEventListener("error", closeOnAbort)
  signal?.addEventListener("abort", closeOnAbort, { once: true })
  if (signal?.aborted || socket.readyState !== WebSocket.OPEN) closeOnAbort()
  const call = <T>(method: string, params: JsonObject = {}, sessionId?: string): Promise<T> => {
    if (closed) return Promise.reject(new Error("Chrome WebSocket is closed"))
    const id = nextId++
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP deadline exceeded for ${method}`))
      }, timeoutMs)
      pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
    })
    try {
      socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
    } catch {
      closeOnAbort()
    }
    return promise
  }
  const close = async (): Promise<void> => {
    if (closed) return
    disconnected()
    socket.close()
    listeners.clear()
  }
  return {
    call,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close,
    isClosed: () => closed,
    onDisconnect: (listener) => {
      if (closed) listener()
      else disconnectListeners.add(listener)
      return () => disconnectListeners.delete(listener)
    },
  }
}
