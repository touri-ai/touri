import type { MouseEvent, ReactNode } from "react"

export type SidebarRowTone = "waiting" | "failed" | "running" | "new"

/** Shared neutral count pill; its accessible label explains what the count includes. */
export const SidebarCount = ({ count, label }: { count: number; label: string }) => (
  <span className="sidebar-unread" role="img" aria-label={label}>
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
