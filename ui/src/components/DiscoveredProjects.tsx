import type { DiscoveredProject } from "@touri/contracts"
import { useEffect, useRef, useState } from "react"
import type { UiApi } from "../api/client"
import { userFacingError } from "../errors"
import { t } from "../i18n"

export const DiscoveredProjects = ({
  api,
  disabled = false,
  onSelect,
  onChooseFolder,
}: {
  api: UiApi
  disabled?: boolean
  onSelect: (repository: DiscoveredProject) => Promise<void>
  onChooseFolder?: (() => Promise<void>) | undefined
}) => {
  const [repositories, setRepositories] = useState<DiscoveredProject[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void api.request("GET /projects/discover", {}).then(
      (result) => {
        if (active) {
          setRepositories(result.repositories)
          setLoading(false)
        }
      },
      () => {
        if (active) {
          setError(t("Não foi possível buscar repositórios. Escolha outra pasta."))
          setLoading(false)
        }
      },
    )
    return () => {
      active = false
    }
  }, [api])
  const run = async (action: () => Promise<void>) => {
    if (disabled || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (error) {
      setError(userFacingError(error))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  return (
    <div className="discovered-projects" aria-busy={loading || busy}>
      <strong>{t("Repositórios encontrados")}</strong>
      {loading ? (
        <p role="status">{t("Buscando repositórios…")}</p>
      ) : (
        !repositories.length && <p className="field-help">{t("Nenhum repositório encontrado.")}</p>
      )}
      <ul>
        {repositories.map((repository) => (
          <li key={repository.path}>
            <button
              type="button"
              className="button-quiet"
              disabled={disabled || busy}
              onClick={() => void run(() => onSelect(repository))}
            >
              <strong>{repository.name}</strong>
              <small>{repository.path}</small>
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="button-quiet"
        disabled={disabled || busy || !onChooseFolder}
        onClick={() => onChooseFolder && void run(onChooseFolder)}
      >
        {t("Escolher outra pasta…")}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
