import type { ApprovalPart } from "@touri/contracts"
import { getTeamProposalReview } from "@touri/contracts"
import { useRef, useState } from "react"
import type { UiApi } from "../api/client"
import { buildDeepLink } from "../deepLink"
import { ApiError, userFacingError } from "../errors"
import { type Locale, type TranslationKey, t } from "../i18n"
import { BotAvatar } from "./BotAvatar"
import "./team-approval.css"

export const TeamApprovalCard = ({
  part,
  api,
  finished,
  onResolved,
  locale = "pt-BR",
}: {
  part: ApprovalPart
  api?: UiApi | undefined
  finished?: boolean | undefined
  onResolved?: (timestamp: number, decision: "approved" | "denied") => void
  locale?: Locale
}) => {
  const [decision, setDecision] = useState<ApprovalPart["decision"]>()
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deletedBotIds, setDeletedBotIds] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const answering = useRef(false)
  const status = part.decision === "pending" ? (decision ?? part.decision) : part.decision
  const review = getTeamProposalReview(part.teamProposal)
  const result = part.teamResult
  const pending = status === "pending"
  const title = getCardTitle(!!review, status, result?.status, !!finished)
  const remainingBots = result?.bots.filter((bot) => !deletedBotIds.includes(bot.id)) ?? []
  const answer = async (approved: boolean) => {
    if (answering.current || !api || !pending || (approved && !review)) return
    answering.current = true
    setBusy(true)
    setError(null)
    try {
      await api.request(
        "POST /approvals/:id",
        { decision: approved ? "approved" : "denied", standing: false },
        { id: part.approvalId },
      )
      setDecision(approved ? "approved" : "denied")
      onResolved?.(Date.now(), approved ? "approved" : "denied")
    } catch (caught) {
      setError(userFacingError(caught))
    } finally {
      answering.current = false
      setBusy(false)
    }
  }
  const deleteCreatedBots = async () => {
    if (!api || deleting || result?.status !== "partial" || !remainingBots.length) return
    setDeleting(true)
    setError(null)
    const outcomes = await Promise.allSettled(
      remainingBots.map(async (bot) => {
        try {
          await api.request("DELETE /bots/:id", { name: bot.name }, { id: bot.id })
        } catch (error) {
          if (!(error instanceof ApiError) || error.errorCode !== "NOT_FOUND") throw error
        }
        return bot.id
      }),
    )
    const deleted = outcomes.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : []))
    setDeletedBotIds((current) => [...new Set([...current, ...deleted])])
    if (outcomes.some((outcome) => outcome.status === "rejected"))
      setError(t("Não foi possível apagar todos os bots. Tente novamente.", {}, locale))
    setDeleting(false)
  }
  const link = (bot: string | null, thread: string | null) =>
    "__TAURI_INTERNALS__" in window
      ? buildDeepLink({ bot, thread })
      : `?${new URLSearchParams({ ...(bot ? { bot } : {}), ...(thread ? { thread } : {}) })}`
  const navigate = (event: React.MouseEvent<HTMLAnchorElement>, bot: string | null, thread: string | null) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    window.dispatchEvent(new CustomEvent("touri:open-conversation", { detail: { bot, thread } }))
  }
  return (
    <article
      className="tool-card team-approval-card"
      aria-label={t("Proposta de time", {}, locale)}
      data-approval-id={part.approvalId}
      data-tool-status={{ pending: "pending", approved: "completed", denied: "denied", expired: "denied" }[status]}
      tabIndex={pending ? 0 : -1}
      aria-busy={busy}
      aria-keyshortcuts={pending ? "Escape" : undefined}
      onKeyDown={(event) => {
        if (
          pending &&
          (event.key === "Enter" || event.key === " ") &&
          (event.target === event.currentTarget ||
            (event.target instanceof Element && event.target.closest(".tool-action-primary")))
        ) {
          event.preventDefault()
          return
        }
        if (pending && event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault()
          event.stopPropagation()
          void answer(false)
        }
      }}
    >
      <header className="team-approval-header">
        <strong>{t(title, {}, locale)}</strong>
        {pending && review && <span role="status">{t("Aguardando sua aprovação", {}, locale)}</span>}
      </header>
      {!review && <p>{t("Cancele e peça uma nova proposta ao bot.", {}, locale)}</p>}
      {review && (
        <>
          <ul className="team-drafts" aria-label={t("Bots propostos", {}, locale)}>
            {review.proposal.bots.map((bot, index) => {
              const provider = review.providers.find((item) => item.provider === bot.provider)
              const providerLabel = getProviderStatusLabel(provider?.status)
              return (
                <li key={bot.name}>
                  <BotAvatar bot={{ ...bot, id: `team-draft-${index}`, color: bot.color ?? null }} size={36} still />
                  <div className="team-draft-body">
                    <strong>{bot.name}</strong>
                    <p>{bot.roleLine}</p>
                    <p className="team-provider">
                      {getProviderName(bot.provider)} · {bot.model || t("Modelo padrão", {}, locale)}
                      <br />
                      <span>{t(providerLabel, {}, locale)}</span>
                    </p>
                    <details open>
                      <summary>{t("Instruções do bot", {}, locale)}</summary>
                      <pre>{bot.instructions}</pre>
                    </details>
                  </div>
                </li>
              )
            })}
          </ul>
          <div className="team-access">
            <strong>{t("Acessos de todos os bots", {}, locale)}</strong>
            <ul>
              <li>{t("Pede permissão antes de mudar arquivos", {}, locale)}</li>
              <li>{t("Máquina local · sem projeto ou pastas extras", {}, locale)}</li>
              <li>{t("Navegador e controle do computador desativados", {}, locale)}</li>
            </ul>
            <p>
              {t(
                "Cada bot começa com estes acessos. Você pode ajustá-los depois nas configurações de cada um.",
                {},
                locale,
              )}
            </p>
          </div>
          {review.proposal.group && (
            <div className="team-group">
              <strong>{t("Grupo: {name}", { name: review.proposal.group.name }, locale)}</strong>
              <p>{review.proposal.group.members.join(" · ")}</p>
              <p>
                {review.proposal.group.coordinator
                  ? t("Coordenador: {name}", { name: review.proposal.group.coordinator }, locale)
                  : t("Sem coordenador", {}, locale)}
              </p>
            </div>
          )}
        </>
      )}
      {(status === "denied" || status === "expired" || result?.status === "failed") && (
        <p role="status">{t("Nenhum bot ou grupo foi criado.", {}, locale)}</p>
      )}
      {result?.status === "partial" && (
        <>
          {remainingBots.length ? (
            <p role="alert">
              {t(
                "A criação parou. Estes bots foram criados; o grupo não foi criado. Você pode mantê-los ou apagá-los antes de tentar novamente.",
                {},
                locale,
              )}
            </p>
          ) : (
            <p role="status">{t("Bots criados apagados.", {}, locale)}</p>
          )}
          {!!remainingBots.length && (
            <button
              className="tool-action tool-action-deny"
              type="button"
              disabled={!api || deleting}
              onClick={() => void deleteCreatedBots()}
            >
              {t(deleting ? "Apagando bots criados…" : "Apagar bots criados", {}, locale)}
            </button>
          )}
        </>
      )}
      {result && remainingBots.length > 0 && (
        <nav className="team-created-links" aria-label={t("Time criado", {}, locale)}>
          {remainingBots.map((bot) => (
            <a
              key={bot.id}
              href={link(bot.id, bot.threadId)}
              onClick={(event) => navigate(event, bot.id, bot.threadId)}
            >
              {bot.name}
            </a>
          ))}
          {result.group && (
            <a
              href={link(null, result.group.threadId)}
              onClick={(event) => navigate(event, null, result.group?.threadId ?? null)}
            >
              {t("Abrir conversa do grupo", {}, locale)} · {result.group.name}
            </a>
          )}
        </nav>
      )}
      {pending && (
        <footer className="team-approval-footer">
          <div className="tool-approval-actions">
            <button
              className="tool-action tool-action-primary"
              type="button"
              disabled={busy || !api || !review}
              onClick={() => void answer(true)}
            >
              {t(busy ? "Enviando…" : "Criar time", {}, locale)}
            </button>
            <button
              className="tool-action tool-action-deny"
              type="button"
              disabled={busy || !api}
              onClick={() => void answer(false)}
            >
              {t("Cancelar", {}, locale)}
            </button>
          </div>
          <small>{t("Com o cartão em foco: Esc cancela", {}, locale)}</small>
        </footer>
      )}
      {error && <p role="alert">{error}</p>}
    </article>
  )
}

const getProviderName = (provider: string) =>
  ({ codex: "Codex", claude: "Claude", opencode: "OpenCode" })[provider] ?? provider

const getCardTitle = (
  hasReview: boolean,
  decision: ApprovalPart["decision"],
  result: string | undefined,
  finished: boolean,
): TranslationKey => {
  if (!hasReview) return "Detalhes indisponíveis"
  if (decision === "pending") return "Proposta de time"
  if (decision === "denied") return "Time cancelado"
  if (decision === "expired") return "A proposta expirou"
  if (result === "created") return "Time criado"
  if (result) return "Não foi possível criar o time. Tente novamente."
  if (finished) return "A criação não terminou. Confira os bots antes de tentar novamente."
  return "Criando time…"
}

const getProviderStatusLabel = (status: string | undefined): TranslationKey => {
  if (status === "ready") return "Pronto para usar"
  if (status === "needs-setup") return "Instalação ou login pendente"
  return "Confira instalação e login nas configurações"
}
