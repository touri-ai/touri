export const browserSandboxMessage =
  "O navegador precisa de namespaces de usuário. No Kubernetes, use hostUsers: false e permita os namespaces no runtime do contêiner. Como último recurso, o operador pode definir TOURI_BROWSER_NO_SANDBOX=1, que desativa a proteção do navegador."

export const browserSandboxWarning =
  "TOURI_BROWSER_NO_SANDBOX=1: a proteção do navegador está desativada. Páginas maliciosas podem acessar os dados e as credenciais do processo."

export class BrowserSandboxUnavailableError extends Error {
  constructor() {
    super(browserSandboxMessage)
    this.name = "BrowserSandboxUnavailableError"
  }
}

/** Start draining immediately; the returned read is used only after Chrome has been stopped. */
export const startChromeSandboxDiagnostic = (stream: ReadableStream<Uint8Array>): (() => Promise<boolean>) => {
  const lifetime = new AbortController()
  const diagnosis = getChromeSandboxDenied(stream, lifetime.signal)

  return async () => {
    // A descendant retaining stderr must not hold up a failed launch indefinitely.
    const timer = setTimeout(() => lifetime.abort(), 500)
    try {
      return await diagnosis
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Keep only a bounded diagnostic prefix; never expose raw browser output to a bot or logs. */
export const getChromeSandboxDenied = async (
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<boolean> => {
  const reader = stream.getReader()
  const cancel = () => void reader.cancel().catch(() => undefined)
  signal?.addEventListener("abort", cancel, { once: true })
  if (signal?.aborted) cancel()
  let prefix = ""
  // Local accumulation is capped, but the pipe continues draining so Chrome cannot block on stderr.
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) return isChromeSandboxDenied(prefix)
      if (prefix.length < 32_768) prefix += new TextDecoder().decode(next.value.subarray(0, 32_768 - prefix.length))
    }
  } catch {
    return isChromeSandboxDenied(prefix)
  } finally {
    signal?.removeEventListener("abort", cancel)
    reader.releaseLock()
  }
}

export const isChromeSandboxDenied = (diagnostic: string): boolean =>
  /No usable sandbox|Failed to move to new namespace|Failed to unshare|namespace.*(?:Operation not permitted|Permission denied)|Running as root without --no-sandbox/iu.test(
    diagnostic.slice(0, 32_768),
  )
