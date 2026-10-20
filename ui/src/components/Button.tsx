import type { ButtonHTMLAttributes, ReactNode } from "react"
import "./ds.css"

export type ButtonVariant = "primary" | "secondary" | "quiet" | "link-action" | "destructive"

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & {
  variant?: ButtonVariant
  type?: "button" | "submit"
}

/** One button per intent; use a single primary per surface. */
export const Button = ({ variant = "secondary", type = "button", className = "", ...props }: ButtonProps) => (
  <button type={type} className={`ds-button ds-button-${variant} ${className}`} {...props} />
)

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger"

/** State chip: soft background with text of the same role. */
export const Badge = ({
  tone = "neutral",
  className = "",
  children,
}: {
  tone?: BadgeTone
  className?: string
  children: ReactNode
}) => <span className={`ds-badge ds-badge-${tone} ${className}`}>{children}</span>

/** Unread counter: a number only, capped at 9+. */
export const UnreadCount = ({ count, className = "" }: { count: number; className?: string }) => {
  if (count < 1) return null

  return <span className={`ds-count ${className}`}>{count > 9 ? "9+" : count}</span>
}
