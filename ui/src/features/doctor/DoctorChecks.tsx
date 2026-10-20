import type { DoctorCheck, DoctorReport, DoctorStatus } from "@touri/contracts"
import { useEffect, useRef, useState } from "react"
import type { UiApi } from "../../api/client"
import { Disclosure } from "../../components/Disclosure"
import { MachineServiceButton } from "../../components/MachineServiceButton"
import { VaultAccessButton } from "../../components/VaultAccessButton"
import { localizeNotice, plural, t } from "../../i18n"
import { DoctorStorage } from "./DoctorStorage"
import { getDoctorCheckCopy } from "./getDoctorCheckCopy"

const labels: Record<DoctorStatus, string> = { pass: "Pronto", warn: "Atenção", fail: "Falha" }
const statusOf = (check: DoctorCheck): DoctorStatus => check.status ?? (check.ok ? "pass" : "fail")
const groupOf = (check: DoctorCheck): string => {
  if (check.id.startsWith("network-") || check.id.startsWith("dns") || check.id.startsWith("tls"))
    return "Conexões com provedores"
  if (check.id.startsWith("vm") || check.id.includes("container")) return "Computadores isolados"
  if (check.id.startsWith("codex") || check.id.startsWith("claude") || check.id.startsWith("opencode"))
    return "Provedores de IA"
  return "Ferramentas locais"
}

const DoctorRow = ({
  check,
  api,
  onRefresh,
}: {
  check: DoctorCheck
  api?: UiApi | undefined
  onRefresh: () => Promise<void>
}) => {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(copiedTimer.current), [])
  const status = statusOf(check)
  const label = check.label ?? check.id
  const presentation = getDoctorCheckCopy(check)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(check.fix ?? "")
      setCopied(true)
      setCopyError(false)
      clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      clearTimeout(copiedTimer.current)
      setCopied(false)
      setCopyError(true)
    }
  }
  return (
    <li className="doctor-check" data-status={status}>
      <span className={`check-icon check-${status === "pass" ? "ok" : status}`} aria-hidden="true">
        {status === "pass" ? "✓" : "!"}
      </span>
      <div className="doctor-check-content">
        <strong>{presentation?.label ?? localizeNotice(label)}</strong>
        <span>
          {check.action === "authorize-vault"
            ? t(
                check.id.startsWith("browser-session:")
                  ? "Permita o acesso ao cofre para restaurar a sessão salva do navegador."
                  : "Permita o acesso ao cofre para usar o login salvo.",
              )
            : (presentation?.nextStep ?? localizeNotice(check.detail))}
        </span>
        {presentation && (
          <Disclosure summary={t("Detalhes técnicos")}>
            <strong>{localizeNotice(label)}</strong>
            <p>{localizeNotice(check.detail)}</p>
          </Disclosure>
        )}
        {status !== "pass" && check.action === "authorize-vault" && check.vaultAccount && (
          <VaultAccessButton account={check.vaultAccount} onAuthorized={onRefresh} />
        )}
        {status !== "pass" &&
          check.fix &&
          (check.action === "authorize-vault" ? (
            <Disclosure summary={t("Outras opções")}>
              <code>{check.fix}</code>
            </Disclosure>
          ) : (
            <div className="doctor-fix">
              <code>{check.fix}</code>
              <div className="doctor-fix-actions">
                {check.action === "start-machine-service" && api && (
                  <MachineServiceButton api={api} onStarted={onRefresh} />
                )}
                <button
                  type="button"
                  className="button button-quiet"
                  aria-label={`Copiar comando para ${label}`}
                  onClick={() => void copy()}
                >
                  <span aria-live="polite" aria-atomic="true">
                    {copied ? "Copiado" : "Copiar comando"}
                  </span>
                </button>
              </div>
              {copyError && <small role="status">Selecione o comando acima e copie manualmente.</small>}
            </div>
          ))}
      </div>
      <span className="doctor-state">{labels[status]}</span>
    </li>
  )
}

export const DoctorChecks = ({
  api,
  doctor,
  error,
  onRefresh,
}: {
  api?: UiApi | undefined
  doctor: DoctorReport | null
  error: string | null
  onRefresh: () => Promise<void>
}) => {
  const running = doctor?.running ?? (!doctor && !error)
  const checks = doctor?.checks ?? []
  const counts = { pass: 0, warn: 0, fail: 0 }
  for (const item of checks) counts[statusOf(item)] += 1
  const groups = new Map<string, DoctorCheck[]>()
  for (const check of checks) {
    const name = groupOf(check)
    const items = groups.get(name) ?? []
    items.push(check)
    groups.set(name, items)
  }
  return (
    <div className="doctor-diagnostics">
      <div className="doctor-toolbar">
        <div role="status" aria-live="polite" className="doctor-summary">
          <strong>
            {running
              ? "Verificando o ambiente…"
              : `${counts.pass} ${plural(counts.pass, "pronto", "prontos")} · ${counts.warn} ${plural(counts.warn, "aviso", "avisos")} · ${counts.fail} ${plural(counts.fail, "falha", "falhas")}`}
          </strong>
          {doctor?.checkedAt && (
            <small>Última verificação: {new Date(doctor.checkedAt).toLocaleTimeString("pt-BR")}</small>
          )}
        </div>
        <button type="button" className="button button-quiet" disabled={running} onClick={() => void onRefresh()}>
          Verificar novamente
        </button>
      </div>
      {error && (
        <p className="doctor-error" role="alert">
          {error}
        </p>
      )}
      <div className="doctor-groups" aria-busy={running}>
        {Array.from(groups, ([name, items]) => (
          <section key={name} className="doctor-group" aria-label={name}>
            <h3>
              {name}
              <span className="count-pill">{items.length}</span>
            </h3>
            <ul className="doctor-list" aria-label={`Verificações do ambiente · ${name}`} aria-busy={running}>
              {items.map((item) => (
                <DoctorRow
                  key={`${doctor?.checkedAt ?? "initial"}:${item.id}`}
                  check={item}
                  api={api}
                  onRefresh={onRefresh}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
      {api && <DoctorStorage api={api} />}
      <p className="doctor-privacy">
        As verificações rodam neste computador. Apenas as sondagens de DNS, TLS e HTTP acessam os provedores; conversas
        e credenciais não são enviadas. Iniciar serviço executa a correção neste computador quando você clica. Os demais
        comandos são executados por você no terminal.
      </p>
    </div>
  )
}
