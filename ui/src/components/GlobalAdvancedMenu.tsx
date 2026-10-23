import type { HostKind } from "@touri/contracts"
import { useEffect, useRef, useState } from "react"
import { getHostLabel, t } from "../i18n"
import { Disclosure } from "./Disclosure"
import { PanelIcon } from "./PanelIcon"

type GlobalAdvancedMenuProps = {
  host?: HostKind | undefined
  page: "cron" | "integracoes" | "mcp" | "work" | "performance" | null
  onPage: (page: "integracoes" | "mcp" | "work" | "performance") => void
  onProject: () => void
  onDoctor: () => void
  onImport: () => void
  onSettings?: ((section: "work" | "api-models") => void) | undefined
}

export const GlobalAdvancedMenu = ({
  host = "computer",
  page,
  onPage,
  onProject,
  onDoctor,
  onImport,
  onSettings,
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
          <Disclosure summary={t("Work")}>
            <button
              type="button"
              className="sidebar-nav-item"
              onClick={() => launch(() => onPage("work"))}
              aria-current={page === "work" ? "page" : undefined}
            >
              {t("Work")}
            </button>
            <button type="button" className="sidebar-nav-item" onClick={() => launch(() => onSettings?.("work"))}>
              {t("People")}
            </button>
          </Disclosure>
          <Disclosure summary={t("Ferramentas")}>
            <button
              type="button"
              className="sidebar-nav-item"
              onClick={() => launch(() => onPage("mcp"))}
              aria-current={page === "mcp" ? "page" : undefined}
            >
              {t("MCP")}
            </button>
            <button
              type="button"
              className="sidebar-nav-item"
              onClick={() => launch(() => onPage("integracoes"))}
              aria-current={page === "integracoes" ? "page" : undefined}
            >
              {t("Integrations")}
            </button>
            <button type="button" className="sidebar-nav-item" onClick={() => launch(() => onSettings?.("api-models"))}>
              {t("API models")}
            </button>
          </Disclosure>
          <button type="button" className="sidebar-nav-item" onClick={() => launch(onProject)}>
            {t("Projects")}
          </button>
          <Disclosure summary={t("Diagnóstico")}>
            <button
              type="button"
              className="sidebar-nav-item"
              onClick={() => launch(() => onPage("performance"))}
              aria-current={page === "performance" ? "page" : undefined}
            >
              {t("Performance")}
            </button>
            <button type="button" className="sidebar-nav-item" onClick={() => launch(onDoctor)}>
              {t("Check this {host}", { host: getHostLabel(host) })}
            </button>
            <button
              type="button"
              className="sidebar-nav-item"
              onClick={() => launch(() => window.dispatchEvent(new Event("touri-report-problem")))}
            >
              {t("Report a problem")}
            </button>
          </Disclosure>
          <button type="button" className="sidebar-nav-item" onClick={() => launch(onImport)}>
            {t("Import")}
          </button>
        </nav>
      )}
    </div>
  )
}
