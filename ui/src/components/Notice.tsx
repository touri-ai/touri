import { type ReactNode, useId, useState } from "react"
import { t } from "../i18n"
import { Button } from "./Button"
import "./Notice.css"

export type NoticeTone = "danger" | "warning" | "info"
export type NoticeAction = { label: string; onClick: () => void | Promise<void>; disabled?: boolean | undefined }

/** One status sentence, its cause and code in meta size, real buttons; details open in place. */
export const Notice = ({
  title,
  cause,
  code,
  details,
  action,
  tone = "danger",
  className = "",
  children,
}: {
  title: string
  cause?: string | undefined
  code?: string | undefined
  details?: string | undefined
  action?: NoticeAction | undefined
  tone?: NoticeTone
  className?: string
  children?: ReactNode
}) => {
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const hasDetails = Boolean(details) && details !== code

  return (
    <div className={`ds-notice ds-notice-${tone} ${className}`} role={tone === "info" ? "status" : "alert"}>
      <div className="ds-notice-body">
        <p className="ds-notice-title">{title}</p>
        {(cause || code) && (
          <p className="ds-notice-cause">
            {cause}
            {cause && code ? " " : null}
            {code && <code>{code}</code>}
          </p>
        )}
        {children}
        {hasDetails && open && (
          <pre id={detailsId} className="ds-notice-details">
            {details}
          </pre>
        )}
      </div>
      <div className="ds-notice-actions">
        {hasDetails && (
          <Button variant="quiet" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)}>
            {t("Detalhes")}
          </Button>
        )}
        {action && (
          <Button variant="primary" disabled={action.disabled} onClick={() => void action.onClick()}>
            {action.label}
          </Button>
        )}
      </div>
    </div>
  )
}
