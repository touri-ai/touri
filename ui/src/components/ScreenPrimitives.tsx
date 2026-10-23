import { type ReactNode, useContext } from "react"
import { PanelIcon } from "./PanelIcon"
import { ScreenHeaderContext } from "./ScreenHeaderContext"

export const ScreenHeader = ({
  id,
  title,
  description,
  actions,
  showBreadcrumb = true,
}: {
  id: string
  title: string
  description: string
  showBreadcrumb?: boolean
  actions?: ReactNode
}) => {
  const registerHeader = useContext(ScreenHeaderContext)

  return (
    <header ref={registerHeader} className="screen-header">
      <div>
        {showBreadcrumb && <span className="screen-crumb">touri / {title}</span>}
        <h1 id={id}>{title}</h1>
        <p>{description}</p>
      </div>
      {actions && <div className="screen-header-actions">{actions}</div>}
    </header>
  )
}

export const ScreenState = ({
  kind,
  title,
  description,
  onRetry,
  children,
}: {
  kind: "loading" | "empty" | "error"
  title?: string
  description?: string
  onRetry?: () => void
  children?: ReactNode
}) => {
  if (kind === "loading")
    return (
      <div className="screen-state screen-loading" role="status" aria-label="Carregando">
        <span className="visually-hidden">Carregando…</span>
        {[0, 1, 2].map((row) => (
          <div className="screen-skeleton-row" key={row} aria-hidden="true">
            <span className="screen-skeleton-mark" />
            <span className="screen-skeleton-copy">
              <i />
              <i />
            </span>
          </div>
        ))}
      </div>
    )
  return (
    <div className={`screen-state screen-${kind}`} role={kind === "error" ? "alert" : undefined}>
      <span className="screen-state-mark" aria-hidden="true">
        {kind === "error" ? <PanelIcon name="warning" /> : "◇"}
      </span>
      <strong>{kind === "error" ? "Não foi possível carregar" : title}</strong>
      {description && <p>{description}</p>}
      {onRetry && (
        <button type="button" className="outline-button" onClick={onRetry}>
          Tentar novamente
        </button>
      )}
      {children}
    </div>
  )
}
