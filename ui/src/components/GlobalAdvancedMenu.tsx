import type { HostKind } from "@touri/contracts"
import { useEffect, useRef, useState } from "react"
import { getHostLabel, t } from "../i18n"
import { PanelIcon } from "./PanelIcon"

type GlobalAdvancedMenuProps = {
  host?: HostKind | undefined
  page: "cron" | "integracoes" | "mcp" | "work" | "performance" | null
  onPage: (page: "integracoes" | "mcp" | "work" | "performance") => void
  onProject: () => void
  onDoctor: () => void
  onImport: () => void
}

export const GlobalAdvancedMenu = ({
  host = "computer",
  page,
  onPage,
  onProject,
  onDoctor,
  onImport,
}: GlobalAdvancedMenuProps) => {
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false)
        trigger.current?.focus()
      }
    }
    window.addEventListener("mousedown", close)
    window.addEventListener("keydown", closeOnEscape)
    return () => {
      window.removeEventListener("mousedown", close)
      window.removeEventListener("keydown", closeOnEscape)
    }
  }, [open])
  const launch = (action: () => void) => {
    setOpen(false)
    // Dialogs capture this trigger as their return destination.
    trigger.current?.focus()
    action()
  }
  return (
    <div className="sidebar-advanced" ref={container}>
      <button
        ref={trigger}
        type="button"
        className="sidebar-connect"
        aria-expanded={open}
        aria-controls="sidebar-advanced-pages"
        onClick={() => setOpen((value) => !value)}
      >
        <PanelIcon name="settings" />
        <span>{t("Advanced")}</span>
        <PanelIcon name={open ? "chevron-down" : "chevron-right"} />
      </button>
      {open && (
        <nav id="sidebar-advanced-pages" className="sidebar-advanced-pages" aria-label={t("Advanced pages")}>
          {(["work", "performance"] as const).map((destination) => (
            <button
              key={destination}
              type="button"
              className="sidebar-nav-item"
              aria-current={page === destination ? "page" : undefined}
              onClick={() => launch(() => onPage(destination))}
            >
              {t(destination === "work" ? "Work" : "Performance")}
            </button>
          ))}
          <button
            type="button"
            className="sidebar-nav-item"
            aria-current={page === "mcp" ? "page" : undefined}
            onClick={() => launch(() => onPage("mcp"))}
          >
            {t("MCP")}
          </button>
          <button
            type="button"
            className="sidebar-nav-item"
            aria-current={page === "integracoes" ? "page" : undefined}
            onClick={() => launch(() => onPage("integracoes"))}
          >
            {t("Integrations")}
          </button>
          <button type="button" className="sidebar-nav-item" onClick={() => launch(onProject)}>
            {t("Projects")}
          </button>
          <button type="button" className="sidebar-nav-item" onClick={() => launch(onDoctor)}>
            {t("Check this {host}", { host: getHostLabel(host) })}
          </button>
          <button type="button" className="sidebar-nav-item" onClick={() => launch(onImport)}>
            {t("Import")}
          </button>
          <button
            type="button"
            className="sidebar-nav-item"
            onClick={() => launch(() => window.dispatchEvent(new Event("touri-report-problem")))}
          >
            {t("Report a problem")}
          </button>
        </nav>
      )}
    </div>
  )
}
