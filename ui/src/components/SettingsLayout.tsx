import {
  type ComponentPropsWithoutRef,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useState,
} from "react"
import { useReveal } from "./Reveal"

const SettingsIdContext = createContext("")

// Keep the native input's label, focus, Space key and form behavior.
export const SettingsSwitch = ({
  className = "",
  ...props
}: Omit<ComponentPropsWithoutRef<"input">, "type" | "role">) => (
  <input
    {...props}
    type="checkbox"
    role="switch"
    aria-checked={props.checked}
    className={`settings-switch ${className}`}
  />
)

export type SettingsIconName =
  | "report"
  | "cloud"
  | "general"
  | "computer"
  | "permissions"
  | "mcp"
  | "routines"
  | "appearance"
  | "shortcuts"
  | "privacy"
  | "notifications"
const paths: Record<SettingsIconName, string> = {
  report: "M5 3h14v18H5zM9 8h6M9 12h6M9 16h2",
  cloud: "M6 18h12a4 4 0 0 0 0-8 6 6 0 0 0-12-2 5 5 0 0 0 0 10",
  general: "M4 7h16M4 17h16M8 4v6M16 14v6",
  computer: "M3 4h18v12H3zM8 21h8M12 16v5",
  permissions: "M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6zM9 12l2 2 4-4",
  mcp: "M8 3v5M16 3v5M6 8h12v4a6 6 0 0 1-12 0zM12 18v3",
  routines: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v5l3 2",
  appearance: "M12 3a9 9 0 1 0 0 18c2 0 3-1 3-3s-2-2-2-4 3-2 5-2c2 0 3-1 3-3 0-4-4-6-9-6M7 9h.01M10 6h.01M15 6h.01",
  shortcuts: "M3 6h18v12H3zM6 9h.01M10 9h.01M14 9h.01M18 9h.01M7 15h10",
  privacy: "M6 10h12v11H6zM8 10V7a4 4 0 0 1 8 0v3M12 14v3",
  notifications: "M5 17h14l-2-3V9a5 5 0 0 0-10 0v5zM10 21h4",
}

export const SettingsIcon = ({ name }: { name: SettingsIconName }) => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={paths[name]} />
  </svg>
)

export type SettingsSection = { id: string; label: string; icon: SettingsIconName }

export const SettingsLayout = ({
  sections,
  active,
  onChange,
  children,
  label,
}: {
  sections: ReadonlyArray<SettingsSection>
  active: string
  onChange: (section: string) => void
  children: ReactNode
  label: string
}) => {
  const id = useId()
  return (
    <SettingsIdContext.Provider value={id}>
      <div className="settings-layout">
        <div className="settings-nav" role="tablist" aria-label={label} aria-orientation="vertical">
          {sections.map((section, index) => (
            <button
              key={section.id}
              id={`${id}-${section.id}`}
              type="button"
              role="tab"
              aria-selected={active === section.id}
              aria-controls={`${id}-pane-${section.id}`}
              tabIndex={active === section.id ? 0 : -1}
              onClick={() => onChange(section.id)}
              onKeyDown={(event) => {
                const offset =
                  event.key === "ArrowDown" || event.key === "ArrowRight"
                    ? 1
                    : event.key === "ArrowUp" || event.key === "ArrowLeft"
                      ? -1
                      : 0
                if (!offset && event.key !== "Home" && event.key !== "End") return
                event.preventDefault()
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? sections.length - 1
                      : (index + offset + sections.length) % sections.length
                const target = sections[next]
                if (target) {
                  onChange(target.id)
                  document.getElementById(`${id}-${target.id}`)?.focus()
                }
              }}
            >
              <SettingsIcon name={section.icon} />
              {section.label}
            </button>
          ))}
        </div>
        <div className="settings-content">{children}</div>
      </div>
    </SettingsIdContext.Provider>
  )
}

export const SettingsPane = ({
  active,
  id,
  title,
  description,
  children,
}: {
  active: string
  id: string
  title: string
  description: string
  children: ReactNode
}) => {
  const layoutId = useContext(SettingsIdContext)
  const reveal = useReveal<HTMLElement>(active === id)
  return (
    <section
      ref={reveal}
      id={`${layoutId}-pane-${id}`}
      className="settings-pane"
      hidden={active !== id}
      role="tabpanel"
      aria-label={title}
      aria-labelledby={`${layoutId}-${id}`}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a tab panel needs a focus target for keyboard scrolling, including sections with no editable controls.
      tabIndex={0}
    >
      <div className="settings-pane-heading">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      {/* Inactive panes stay empty: a <select> inside a display:none subtree drops every later sibling from the macOS accessibility tree. */}
      {active === id && children}
    </section>
  )
}

export const SettingsGroup = ({ title, children }: { title?: string; children: ReactNode }) => (
  <div className="settings-group">
    {title && <h4>{title}</h4>}
    <div className="settings-group-card">{children}</div>
  </div>
)

export const SettingsRow = ({
  title,
  description,
  children,
  htmlFor,
  descriptionId,
  settingId,
}: {
  title: string
  description: string
  children: ReactNode
  htmlFor?: string
  descriptionId?: string
  /** Registry id so the command palette can focus and highlight this row. */
  settingId?: string
}) => (
  <div className="settings-row" data-setting-id={settingId}>
    <div className="settings-row-copy">
      {htmlFor ? <label htmlFor={htmlFor}>{title}</label> : <strong>{title}</strong>}
      <p id={descriptionId}>{description}</p>
    </div>
    <div className="settings-row-control">{children}</div>
  </div>
)

export const SettingsDisclosure = ({
  title,
  description,
  defaultOpen = false,
  onOpenChange,
  children,
}: {
  title: string
  description: string
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  children: ReactNode | ((open: boolean) => ReactNode)
}) => {
  const [open, setOpen] = useState(defaultOpen)
  useEffect(() => {
    if (defaultOpen) setOpen(true)
  }, [defaultOpen])
  return (
    <details
      className="settings-disclosure"
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open)
        onOpenChange?.(event.currentTarget.open)
      }}
    >
      <summary>
        <span>
          <strong>{title}</strong>
          <small>{description}</small>
        </span>
      </summary>
      <div className="settings-disclosure-content">{typeof children === "function" ? children(open) : children}</div>
    </details>
  )
}
