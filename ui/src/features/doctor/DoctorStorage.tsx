import type { ApiRoutes } from "@touri/contracts"
import { useEffect, useState } from "react"
import type { UiApi } from "../../api/client"
import { t } from "../../i18n"

type Report = ApiRoutes["GET /doctor/storage"]["res"]
const size = (bytes: number) => `${(bytes / 1024 ** 2).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`

export const DoctorStorage = ({ api }: { api: UiApi }) => {
  const [report, setReport] = useState<Report | null>(null)
  const [vacuum, setVacuum] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const polling = report?.maintenance.running ?? false
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      try {
        const next = await api.request("GET /doctor/storage", {})
        if (!active) return
        setReport(next)
        if (next.maintenance.running) timer = setTimeout(() => void read(), 1000)
      } catch {
        if (active) setError("Não foi possível consultar o armazenamento.")
      }
    }
    if (polling) timer = setTimeout(() => void read(), 1000)
    else void read()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [api, polling])
  const compact = async () => {
    setBusy(true)
    setError(null)
    try {
      const next = await api.request("POST /doctor/storage/compact", { vacuum })
      setReport((current) => (current ? { ...current, maintenance: next.maintenance } : null))
    } catch {
      setError(
        "Não foi possível iniciar a compactação. Aguarde a migração ou compactação em andamento e tente novamente.",
      )
    } finally {
      setBusy(false)
    }
  }
  const running = busy || report?.maintenance.running
  return (
    <section className="doctor-group" aria-label="Armazenamento">
      <h3>Armazenamento</h3>
      {report && (
        <div>
          <p>
            Banco: {size(report.storage.databaseBytes)} · Diário: {size(report.storage.walBytes)} · Espaço reutilizável:{" "}
            {size(report.storage.reusableBytes)}
          </p>
          <p>
            Texto: {size(report.storage.messageTextBytes)} · Detalhes: {size(report.storage.messagePartsBytes)} ·
            Histórico de eventos: {size(report.storage.transcriptBytes + report.storage.eventBytes)} · Anexos:{" "}
            {size(report.storage.attachmentBytes)}
          </p>
        </div>
      )}
      <p>
        Resume detalhes antigos conforme a preferência de retenção e preserva o texto das conversas. Resultados grandes
        e capturas ficam em anexos.
      </p>
      <label>
        <input
          type="checkbox"
          checked={vacuum}
          disabled={Boolean(running)}
          onChange={(event) => setVacuum(event.target.checked)}
        />
        Recuperar espaço do banco (VACUUM)
      </label>
      <p className="muted-copy">
        Recuperar espaço pode levar alguns segundos. Esta etapa só roda quando você a seleciona.
      </p>
      <button
        type="button"
        className="button button-quiet"
        disabled={!report || Boolean(running)}
        onClick={() => void compact()}
      >
        {running ? "Compactando dados…" : "Compactar dados"}
      </button>
      <p role="status" aria-live="polite">
        {report?.maintenance.running
          ? t("Storage records processed", {
              processed: report.maintenance.processed.toLocaleString("pt-BR"),
              total: report.maintenance.total.toLocaleString("pt-BR"),
              count: report.maintenance.total,
            })
          : ""}
        {error ?? report?.maintenance.error}
      </p>
    </section>
  )
}
