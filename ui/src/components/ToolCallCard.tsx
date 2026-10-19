import type { ApprovalPart } from "@touri/contracts"
import { type KeyboardEventHandler, type ReactNode, useEffect, useId, useState } from "react"
import type { UiApi } from "../api/client"
import { t } from "../i18n"
import { compactApprovalDiff } from "./approvalContent"
import { browserToolPresentation, browserToolResult } from "./browserToolPresentation"
import { DiffOutput } from "./DiffOutput"
import { RevealDetails, useReveal } from "./Reveal"
import { ToolCode } from "./ToolCode"
import { StoredToolOutput, ToolOutput, ToolText } from "./ToolOutput"
import { type ToolKind, type ToolPart, type ToolStatus, toolPresentation, toolStatus } from "./toolPresentation"
import "./approval-content.css"

const iconPaths = {
  terminal: "m5 6 4 4-4 4m7 0h5",
  browser: "M3 5h18v14H3zM3 9h18M6 7h.01M9 7h.01",
  computer: "M3 4h18v13H3zM8 21h8m-4-4v4",
  files: "M5 3h9l5 5v13H5zM14 3v5h5M8 12h8m-8 4h6",
  tool: "m12 3 9 5v8l-9 5-9-5V8zM3 8l9 5 9-5m-9 5v8",
  pending: "M12 8v5m0 3h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18",
  running: "M12 3a9 9 0 1 0 9 9M12 7v5l3 2",
  completed: "m6 12 4 4 8-9",
  denied: "m7 7 10 10M17 7 7 17",
  error: "M12 8v5m0 3h.01M12 3 2 21h20z",
  closed: "M6 6h12v12H6z",
}

export const ToolIcon = ({ kind }: { kind: ToolKind | ToolStatus }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={iconPaths[kind]} />
  </svg>
)

const labels: Record<ToolStatus, string> = {
  pending: "Aguardando aprovação",
  running: "Executando",
  completed: "Concluído",
  denied: "Negado",
  error: "Erro",
  closed: "Encerrado",
}

export const toolTime = (timestamp: number): string =>
  new Date(timestamp).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })

const CommandElapsed = ({ startedAt }: { startedAt: number }) => {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])
  return (
    <span role="timer" aria-label="Tempo de execução">
      {" "}
      · {Math.max(0, Math.floor((now - startedAt) / 1_000))} s
    </span>
  )
}

const ApprovalContext = ({ review }: { review: { reason: string; scope: { label: string; value: string }[] } }) => {
  const rows = [{ label: "Motivo", value: review.reason }, ...review.scope].filter((row) => row.value)
  if (!rows.length) return <p className="tool-approval-unknown">{t("O provedor não detalhou o pedido")}</p>

  return (
    <dl className="tool-approval-context">
      {rows.map(({ label, value }) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export const ToolCallCard = ({
  part,
  approval,
  finished = false,
  createdAt,
  decidedAt,
  actions,
  busy,
  error,
  onKeyDown,
  api,
}: {
  api?: UiApi | undefined
  part?: ToolPart | undefined
  approval?: ApprovalPart | undefined
  finished?: boolean | undefined
  createdAt?: number | undefined
  decidedAt?: number | undefined
  actions?: ReactNode
  busy?: boolean
  error?: string | null
  onKeyDown?: KeyboardEventHandler<HTMLElement>
}) => {
  const titleId = useId()
  const revealRef = useReveal<HTMLElement>()
  const browser = browserToolPresentation(part?.type === "tool_call" ? part : undefined)
  const presentation = { ...toolPresentation(part, approval), ...browser }
  const reviewedFiles = new Map(presentation.review?.files.map((file) => [file.path, file]))
  const result = browser && part?.type === "tool_call" ? browserToolResult(part.outputJson) : null
  const pending = approval?.decision === "pending"
  const status = pending
    ? "pending"
    : approval?.decision === "denied"
      ? "denied"
      : approval?.decision === "expired"
        ? "closed"
        : toolStatus(part, finished)
  const timestamp =
    approval?.decision === "denied" || approval?.decision === "expired"
      ? decidedAt
      : pending
        ? createdAt
        : (part?.resolvedAt ?? createdAt)
  const liveCommand = status === "running" && presentation.kind === "terminal"
  const rawOutput =
    part?.type === "tool_call"
      ? liveCommand
        ? part.outputTail || part.outputJson
        : (part.outputJson ?? part.outputTail)
      : part?.type === "command"
        ? part.outputTail || (liveCommand ? null : "Sem saída")
        : part?.diff
  return (
    <article
      ref={revealRef}
      className={`tool-card tool-call-card tool-surface-reveal${approval ? " approval-card" : ""}${approval?.standing ? " approval-standing" : ""}`}
      aria-label={approval ? "Aprovação de ferramenta" : `Ferramenta · ${presentation.name}`}
      aria-describedby={titleId}
      aria-busy={busy}
      data-tool-status={status}
      data-call-id={part?.callId}
      data-approval-id={approval?.approvalId}
      data-approval-scope={approval?.decision === "approved" ? (approval.standing ? "standing" : "once") : undefined}
      id={approval ? `approval-${approval.approvalId}` : undefined}
      tabIndex={pending ? 0 : approval ? -1 : undefined}
      onKeyDown={onKeyDown}
    >
      <header className="tool-card-header">
        <span className="tool-kind-icon">
          <ToolIcon kind={presentation.kind} />
        </span>
        <strong id={titleId}>{presentation.name}</strong>
        {part?.type === "command" && part.exitCode !== null && (
          <span className={`tool-exit-chip ${part.exitCode === 0 ? "tool-exit-ok" : "tool-exit-fail"}`}>
            {part.exitCode === 0 ? "Saída 0 · OK" : `Saída ${part.exitCode} · Falha`}
          </span>
        )}
        <span className="tool-status-chip" role="status">
          <ToolIcon kind={status} />
          {labels[status]}
          {timestamp !== undefined && (
            <time dateTime={new Date(timestamp).toISOString()}> · {toolTime(timestamp)}</time>
          )}
          {liveCommand && part && "startedAt" in part && part.startedAt !== undefined && (
            <CommandElapsed startedAt={part.startedAt} />
          )}
        </span>
      </header>
      <p className="tool-summary" title={presentation.summary}>
        {presentation.summary}
      </p>
      {presentation.filePaths.length > 0 && (
        <ul className="tool-file-list" aria-label="Arquivos">
          {[...new Set(presentation.filePaths)].map((path) => (
            <li key={path}>
              {reviewedFiles.has(path) && <span>{reviewedFiles.get(path)?.action} </span>}
              <span className="tool-file-chip" title={path}>
                <ToolIcon kind="files" />
                <span className="tool-file-path">{path.slice(0, path.lastIndexOf("/") + 1)}</span>
                <strong>{path.slice(path.lastIndexOf("/") + 1)}</strong>
              </span>
              {reviewedFiles.get(path)?.diff && (
                <figure className="tool-approval-diff" aria-label={`Prévia das alterações em ${path}`}>
                  <pre>
                    <code>{compactApprovalDiff(reviewedFiles.get(path)?.diff ?? "")}</code>
                  </pre>
                </figure>
              )}
            </li>
          ))}
        </ul>
      )}
      {pending && presentation.review?.missingFiles && (
        <p className="tool-summary">{presentation.review.missingFiles}</p>
      )}
      {presentation.review?.diff && (
        <figure className="tool-approval-diff" aria-label="Prévia das alterações">
          <pre>
            <code>{compactApprovalDiff(presentation.review.diff)}</code>
          </pre>
        </figure>
      )}
      {presentation.code && (
        <figure
          className="tool-code-region"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable code region needs keyboard access
          tabIndex={0}
          aria-label={presentation.kind === "terminal" ? "Comando" : "Parâmetros"}
        >
          <pre className="tool-input">
            {presentation.kind === "terminal" ? (
              <ToolCode text={presentation.code} language="shellscript" />
            ) : (
              <code>{presentation.code}</code>
            )}
          </pre>
        </figure>
      )}
      {approval && !pending && (
        <div
          className={`tool-decision-chip ${approval.decision === "approved" ? "tool-decision-approved" : "tool-decision-denied"}`}
          role="status"
        >
          <ToolIcon
            kind={
              approval.decision === "approved" ? "completed" : approval.decision === "expired" ? "closed" : "denied"
            }
          />
          {approval.decision === "approved"
            ? "Aprovado por você"
            : approval.decision === "expired"
              ? "Aprovação expirada"
              : "Negado por você"}
          {decidedAt !== undefined && (
            <time dateTime={new Date(decidedAt).toISOString()}> · {toolTime(decidedAt)}</time>
          )}
        </div>
      )}
      {pending && presentation.review && <ApprovalContext review={presentation.review} />}
      {approval?.standing && <strong className="tool-standing-label">{t("Permissão permanente neste bot")}</strong>}
      {actions}
      {error && (
        <p className="tool-action-error" role="alert">
          {error}
        </p>
      )}
      {result?.title && <p className="tool-summary">{result.title}</p>}
      {result?.url && <p className="tool-summary">{result.url}</p>}
      {liveCommand && !rawOutput && !part?.outputAttachmentId && (
        <p className="tool-summary">
          {part && "outputMode" in part && part.outputMode === "on_completion"
            ? "A saída aparece quando o comando terminar."
            : "Aguardando saída do comando…"}
        </p>
      )}
      {part?.outputAttachmentId ? (
        <StoredToolOutput
          key={part.outputAttachmentId}
          api={api}
          attachmentId={part.outputAttachmentId}
          preview={part.outputPreview}
          callId={part.callId}
          diff={part.type === "file_change"}
          browser={!!browser}
        />
      ) : (result ? result.output : rawOutput) != null ? (
        part?.type === "file_change" ? (
          <RevealDetails className="tool-details tool-output" summary="Resultado">
            <DiffOutput source={rawOutput ?? ""} />
          </RevealDetails>
        ) : (
          <ToolOutput
            raw={(result ? result.output : rawOutput) ?? ""}
            callId={part?.callId ?? "tool-output"}
            live={liveCommand}
          />
        )
      ) : null}
      {part && !part.outputAttachmentId && rawOutput == null && status === "closed" && (
        <p className="tool-output-unavailable">Resultado histórico indisponível.</p>
      )}
      {presentation.technical && (
        <RevealDetails className="tool-details tool-technical" summary="Detalhes técnicos">
          <ToolText text={presentation.technical} language="json" />
        </RevealDetails>
      )}
    </article>
  )
}
