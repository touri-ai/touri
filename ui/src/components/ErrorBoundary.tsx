import { Component, type ErrorInfo, type ReactNode } from "react"
import { createApiClient, createTauriInvoke, resolveSidecarEndpoint, type UiApi, webEndpoint } from "../api/client"
import { ReportErrorButton } from "../features/reports/ReportErrorButton"
import { t } from "../i18n"
import { Disclosure } from "./Disclosure"

const reportError = async (api: UiApi | undefined, area: string, error: Error, info: ErrorInfo) => {
  const client =
    api ??
    createApiClient({
      endpoint:
        "__TAURI_INTERNALS__" in window
          ? await resolveSidecarEndpoint(createTauriInvoke())
          : webEndpoint(window.location),
    })
  await client.request("POST /ui/errors", {
    area: area.slice(0, 16_000),
    message: String(error.message ?? error).slice(0, 16_000),
    stack: (error.stack ?? "").slice(0, 16_000),
    componentStack: (info.componentStack ?? "").slice(0, 16_000),
  })
}

type Props = {
  children: ReactNode
  area: string
  api?: UiApi | undefined
  app?: boolean
  dialog?: boolean
  onClose?: (() => void) | undefined
}

export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Reporting must never take down the fallback if the sidecar is unavailable.
    void reportError(
      this.props.api,
      this.props.area,
      error instanceof Error ? error : new Error(String(error)),
      info,
    ).catch(() => undefined)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const fallback = (
      <section
        className={`render-error ${this.props.app ? "render-error-app" : ""}`}
        role="alert"
        aria-label={`Erro em ${this.props.area}`}
      >
        <h2>{this.props.app ? "O app encontrou um erro" : `Não foi possível mostrar ${this.props.area}`}</h2>
        <p>Suas conversas continuam salvas. Recarregue para tentar novamente.</p>
        <button
          className="button button-brand"
          type="button"
          onClick={() => {
            if (this.props.app) window.location.reload()
            else this.setState({ error: null })
          }}
        >
          {this.props.app ? "Recarregar app" : "Recarregar esta área"}
        </button>
        <ReportErrorButton api={this.props.api} message={error.stack ?? error.message} fallbackCode="TOURI-E1000" />
        {this.props.onClose && (
          <button className="button button-quiet" type="button" onClick={this.props.onClose}>
            Fechar
          </button>
        )}
        <Disclosure summary={t("Error details")}>
          <pre>{error.stack ?? String(error)}</pre>
        </Disclosure>
      </section>
    )
    return this.props.dialog ? (
      <div className="modal-backdrop" role="presentation">
        <section className="modal-card" role="dialog" aria-modal="true" aria-label="Erro no diálogo">
          {fallback}
        </section>
      </div>
    ) : (
      fallback
    )
  }
}
