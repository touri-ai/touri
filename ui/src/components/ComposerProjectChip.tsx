import type { Bot, Id, Project } from "@touri/contracts"
import { useEffect, useId, useRef, useState } from "react"
import { userFacingError } from "../errors"
import { t } from "../i18n"
import { PanelIcon } from "./PanelIcon"

export const ComposerProjectChip = ({
  bot,
  projects,
  active,
  onSelect,
  onAdd,
}: {
  bot: Bot
  projects: Project[]
  active: boolean
  onSelect: ((projectId: Id | null) => Promise<void>) | undefined
  onAdd: (() => void) | undefined
}) => {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const restoreFocus = useRef(false)
  const savingRef = useRef(false)
  const menuId = useId()
  const lockedId = useId()
  const noteId = useId()
  const disabled = active || saving || !onSelect
  const project = projects.find((item) => item.id === bot.projectId)
  const label = project?.name ?? t("Sem projeto")
  const lockedHint = t("Aguarde o turno terminar para alterar o projeto.")

  const close = (restore = false) => {
    restoreFocus.current = restore
    setOpen(false)
  }

  useEffect(() => {
    if (active) setOpen(false)
  }, [active])

  useEffect(() => {
    if (!open) {
      if (restoreFocus.current) {
        restoreFocus.current = false
        trigger.current?.focus()
      }
      return
    }
    const selected = menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
    const initialFocus = selected ?? menu.current?.querySelector<HTMLButtonElement>("button")
    initialFocus?.focus()
    const dismiss = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("pointerdown", dismiss)
    document.addEventListener("focusin", dismiss)
    return () => {
      document.removeEventListener("pointerdown", dismiss)
      document.removeEventListener("focusin", dismiss)
    }
  }, [open])

  const select = async (projectId: Id | null) => {
    if (disabled || savingRef.current || !onSelect) return
    if (projectId === bot.projectId) return close(true)
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      await onSelect(projectId)
      close(true)
    } catch (failure) {
      setError(`${t("Não foi possível alterar o projeto.")} ${userFacingError(failure)}`)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <div ref={root} className="composer-project" title={active ? lockedHint : undefined}>
      <button
        ref={trigger}
        type="button"
        className="composer-model composer-project-chip"
        aria-label={t("Projeto do bot")}
        aria-haspopup="menu"
        aria-expanded={open && !active}
        aria-controls={open && !active ? menuId : undefined}
        aria-describedby={active ? lockedId : undefined}
        title={active ? lockedHint : label}
        disabled={disabled}
        onClick={() => {
          setError(null)
          setOpen((value) => !value)
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault()
            setError(null)
            setOpen(true)
          }
        }}
      >
        <PanelIcon name="folder" />
        <span className="composer-model-name">{label}</span>
        <span aria-hidden="true">⌄</span>
      </button>
      {active && (
        <span id={lockedId} className="visually-hidden">
          {lockedHint}
        </span>
      )}
      {open && !active && (
        <div className="project-menu composer-project-picker">
          <div
            ref={menu}
            id={menuId}
            role="menu"
            aria-label={t("Projeto do bot")}
            aria-describedby={bot.machine === "vm" ? noteId : undefined}
            aria-busy={saving}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                event.stopPropagation()
                close(true)
              } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault()
                const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])
                const index = items.indexOf(document.activeElement as HTMLButtonElement)
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length
                items[next]?.focus()
              }
            }}
          >
            {projects
              .filter((item) => item.archivedAt === null)
              .map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={item.id === bot.projectId}
                  aria-disabled={saving}
                  onClick={() => void select(item.id)}
                >
                  <span className="composer-model-name" title={item.name}>
                    {item.name}
                  </span>
                  <span aria-hidden="true">{item.id === bot.projectId ? "✓" : ""}</span>
                </button>
              ))}
            <button
              type="button"
              role="menuitemradio"
              aria-checked={bot.projectId === null}
              aria-disabled={saving}
              onClick={() => void select(null)}
            >
              <span>{t("Nenhum projeto (começa na pasta do bot)")}</span>
              <span aria-hidden="true">{bot.projectId === null ? "✓" : ""}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              aria-disabled={saving || !onAdd}
              onClick={() => {
                if (savingRef.current || !onAdd) return
                close()
                trigger.current?.focus()
                onAdd()
              }}
            >
              {t("Adicionar projeto…")}
            </button>
          </div>
          {bot.machine === "vm" && (
            <p id={noteId} className="composer-project-note">
              {t("Commit Git copiado para /workspace a partir da próxima mensagem.")}
            </p>
          )}
          {error && (
            <p className="composer-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
