import type { ServerModeStatus } from "@touri/contracts"
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { createTauriInvoke, type TauriInvoke } from "../../api/client"
import { t } from "../../i18n"
import { setStorageScope } from "../../storageScope"

const nativeInvoke = createTauriInvoke()
export const isNativeDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
export const serverModeErrorCode = (value: unknown) =>
  (value instanceof Error ? value.message : String(value)).match(/(?:SERVER|VAULT)_[A-Z_]+/)?.[0] ?? null

/** Native errors are identifiers only; never surface transport details or credentials. */
export const serverModeError = (value: unknown): string => {
  const code = value instanceof Error ? value.message : String(value)
  if (code.includes("VAULT_"))
    return t("Não foi possível acessar o cofre do sistema. Desbloqueie-o e tente novamente ou volte ao modo local.")
  if (/SERVER_(URL|INVALID_URL|INSECURE)/.test(code))
    return t("Use um endereço HTTPS do seu servidor touri. HTTP só é permitido neste computador.")
  if (/SERVER_(PAIR|CODE|AUTH|UNAUTHORIZED)/.test(code))
    return t("Não foi possível parear este aplicativo. Gere outro código no servidor e tente novamente.")
  if (code.includes("SERVER_RATE_LIMITED"))
    return t("Muitas tentativas de pareamento. Aguarde alguns minutos e gere outro código no servidor.")
  if (code.includes("SERVER_VERSION_MISMATCH"))
    return t("Esta versão do aplicativo precisa de uma atualização para conversar com o servidor.")
  return t("Não foi possível conectar ao servidor. Confira o endereço e a rede e tente novamente.")
}

const useStatus = (invoke: TauriInvoke, enabled: boolean) => {
  const [status, setStatus] = useState<ServerModeStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [loading, setLoading] = useState(enabled)
  const active = useRef(true)
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    if (!enabled) return
    const attempt = ++generation.current
    setLoading(true)
    try {
      const next = await invoke("server_mode_status", {})
      if (!active.current || attempt !== generation.current) return
      if (!next || (next.mode !== "local" && next.mode !== "server")) throw new Error("SERVER_STATUS")
      setStorageScope(next.mode === "server" ? (next.url ?? "https://unavailable.invalid") : null)
      setStatus(next)
      setError(null)
      setErrorCode(null)
    } catch (caught) {
      if (!active.current || attempt !== generation.current) return
      setStorageScope("https://unavailable.invalid")
      setError(serverModeError(caught))
      setErrorCode(serverModeErrorCode(caught))
    } finally {
      if (active.current && attempt === generation.current) setLoading(false)
    }
  }, [invoke, enabled])
  useEffect(() => {
    active.current = true
    void refresh()
    return () => {
      active.current = false
      generation.current += 1
    }
  }, [refresh])
  return useMemo(() => ({ status, error, errorCode, loading, refresh }), [status, error, errorCode, loading, refresh])
}

const ServerModeContext = createContext<ReturnType<typeof useStatus> | undefined>(undefined)

export const ServerModeProvider = ({
  children,
  invoke = nativeInvoke,
  fallback = null,
}: {
  children: ReactNode
  invoke?: TauriInvoke | undefined
  fallback?: ReactNode
}) => {
  if (!isNativeDesktop()) setStorageScope(null)
  const state = useStatus(invoke, isNativeDesktop())
  if (state.loading && !state.status && !state.error) return fallback
  return <ServerModeContext.Provider value={state}>{children}</ServerModeContext.Provider>
}

/** Standalone settings and recovery dialogs also work before the API is available. */
export const useServerMode = (invoke = nativeInvoke) => {
  const context = useContext(ServerModeContext)
  const fallback = useStatus(invoke, isNativeDesktop() && !context)
  return context ?? fallback
}

export const useIsServerMode = () => useServerMode().status?.mode === "server"
