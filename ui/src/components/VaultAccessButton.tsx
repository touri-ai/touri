import { invoke } from "@tauri-apps/api/core"
import { useEffect, useRef, useState } from "react"
import { t } from "../i18n"

/** System authorization runs in the foreground native process; no secret reaches the webview. */
export const VaultAccessButton = ({
  account,
  onAuthorized,
  resumeMessage = false,
}: {
  account: string
  onAuthorized: () => Promise<unknown>
  resumeMessage?: boolean
}) => {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const generation = useRef(0)
  const pending = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new account invalidates the pending authorization
  useEffect(() => {
    generation.current++
    pending.current = false
    setBusy(false)
    setError(false)
    return () => {
      generation.current++
    }
  }, [account])
  const authorize = async () => {
    if (pending.current) return
    const current = generation.current
    const active = () => current === generation.current
    pending.current = true
    setBusy(true)
    setError(false)
    try {
      await invoke("vault_authorize", { account })
      if (active()) await onAuthorized()
    } catch {
      if (active()) setError(true)
    } finally {
      if (active()) {
        pending.current = false
        setBusy(false)
      }
    }
  }
  return (
    <div>
      <button type="button" className="button button-brand" disabled={busy} onClick={() => void authorize()}>
        {t(busy ? "Aguardando permissão do macOS…" : "Permitir acesso ao cofre")}
      </button>
      <p role={error ? "alert" : "status"}>
        {t(
          error
            ? "O acesso não foi autorizado. Tente novamente e escolha Permitir sempre na janela do macOS."
            : resumeMessage
              ? "Na janela do macOS, escolha Permitir sempre. Sua mensagem continuará automaticamente."
              : "Na janela do macOS, escolha Permitir sempre.",
        )}
      </p>
    </div>
  )
}
