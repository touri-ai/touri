import type { MouseEvent, ReactNode } from "react"

export type SidebarRowTone = "waiting" | "failed" | "running" | "new"

/** Count pills use blue for unread messages and amber for items that need attention. */
export const SidebarCount = ({
  count,
  label,
  tone = "unread",
}: {
  count: number
  label: string
  tone?: "attention" | "unread"
}) => (
  <span className="sidebar-unread" data-tone={tone} role="img" aria-label={label}>
    {count > 99 ? "99+" : count}
  </span>
)

/** State marker (needs you, failed, working): a dot, never a number. */
export const SidebarDot = ({ tone, label }: { tone: SidebarRowTone; label: string }) => (
  <span className={`sidebar-status-dot state-${tone}`} role="img" aria-label={label} />
)

/** Channels and direct messages share this row: leading mark, one-line label, one trailing marker, optional actions. */
export const SidebarRow = ({
  selected,
  rowAttention,
  leading,
  label,
  trailing,
  actions,
  className = "",
  rowClassName = "",
  ariaLabel,
  title,
  expanded,
  onClick,
  onContextMenu,
}: {
  selected: boolean
  rowAttention?: string | undefined
  leading: ReactNode
  label: ReactNode
  trailing?: ReactNode
  actions?: ReactNode
  className?: string
  rowClassName?: string
  ariaLabel?: string | undefined
  title?: string | undefined
  expanded?: boolean | undefined
  onClick: () => void
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void
}) => (
  <div className={`sidebar-row ${rowClassName} ${selected ? "selected" : ""}`} data-attention={rowAttention}>
    <button
      type="button"
      className={`sidebar-row-main ${className}`}
      aria-label={ariaLabel}
      aria-current={selected ? "page" : undefined}
      aria-expanded={expanded}
      title={title}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <span className="sidebar-row-leading" aria-hidden="true">
        {leading}
      </span>
      <span className="sidebar-row-label">{label}</span>
      {trailing}
    </button>
    {actions && <div className="sidebar-row-actions">{actions}</div>}
  </div>
)
