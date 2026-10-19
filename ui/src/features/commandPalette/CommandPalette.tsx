import type { ApiRoutes, Bot, Message, Thread } from "@touri/contracts"
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { UiApi } from "../../api/client"
import { MotionPresence } from "../../components/Motion"
import { threadTitle } from "../../i18n"
import { markdownSummary } from "../../markdownSummary"
import {
  buildMessageIndex,
  buildPaletteIndex,
  type PaletteCommand,
  type PaletteItem,
  readRecentPaletteIds,
  rememberPaletteItem,
  searchPalette,
} from "./paletteItems"
import type { SettingsIndexEntry } from "./settingsRegistry"
import { paletteShortcutLabel } from "./shortcut"
import "./command-palette.css"

export const PALETTE_LABEL = "Paleta de comandos"
export const PALETTE_INPUT_LABEL = "Buscar bots, conversas e configurações"

type CommandPaletteProps = {
  api?: UiApi
  open: boolean
  bots: ReadonlyArray<Bot>
  threads: ReadonlyArray<Thread>
  messages: ReadonlyArray<Message>
  settings: ReadonlyArray<SettingsIndexEntry>
  hasBot: boolean
  onClose: () => void
  onRun: (command: PaletteCommand) => void
}

const resultCountLabel = (count: number): string => {
  if (count === 0) return "Nenhum resultado encontrado."
  return count === 1 ? "1 resultado" : `${count} resultados`
}

export const CommandPalette = ({
  api,
  open,
  bots,
  threads,
  messages,
  settings,
  hasBot,
  onClose,
  onRun,
}: CommandPaletteProps) => {
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const [recentIds, setRecentIds] = useState<Array<string>>(readRecentPaletteIds)
  const [search, setSearch] = useState<{ query: string; hits: ApiRoutes["GET /search"]["res"]["hits"] }>({
    query: "",
    hits: [],
  })
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const baseId = useId()
  const index = useMemo(() => buildPaletteIndex({ bots, threads, settings, hasBot }), [bots, threads, settings, hasBot])
  const messageIndex = useMemo(() => (open ? buildMessageIndex(messages, threads) : []), [open, messages, threads])
  const groups = useMemo(() => {
    const groups = searchPalette({ index, query, messages: messageIndex, recentIds })
    if (!open || search.query !== query || !query.trim()) return groups
    const local = groups.find((group) => group.id === "messages")?.items ?? []
    const items = new Map(local.map((item) => [item.id, item]))
    for (const hit of search.hits) {
      const thread = threads.find((thread) => thread.id === hit.threadId)
      const id = `message:${hit.messageId}`
      if (thread && !items.has(id))
        items.set(id, {
          id,
          group: "messages",
          label: markdownSummary(hit.snippet),
          detail: markdownSummary(threadTitle(thread.title, thread.createdAt)),
          command: { kind: "thread", threadId: thread.id },
        })
    }
    return items.size
      ? [
          ...groups.filter((group) => group.id !== "messages"),
          { id: "messages" as const, label: "Mensagens", items: [...items.values()].slice(0, 8) },
        ]
      : groups
  }, [index, query, messageIndex, recentIds, search, threads, open])
  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups])
  const activeIndex = flat.length === 0 ? -1 : Math.min(active, flat.length - 1)
  const optionId = (position: number): string => `${baseId}-option-${position}`

  useEffect(() => {
    if (!api || !open || !query.trim()) return
    let active = true
    const timer = window.setTimeout(() => {
      void api
        .request("GET /search", { q: query })
        .then(({ hits }) => {
          if (active) setSearch({ query, hits })
        })
        .catch(() => {
          if (active) setSearch({ query, hits: [] })
        })
    }, 150)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [api, open, query])

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement
    returnFocus.current = previous instanceof HTMLElement && previous !== document.body ? previous : null
    setQuery("")
    setActive(0)
    setRecentIds(readRecentPaletteIds())
    inputRef.current?.focus()
    return () => {
      const target = returnFocus.current
      const current = document.activeElement
      const focusLost = !current || current === document.body || Boolean(current.closest?.(".command-palette"))
      if (target?.isConnected && focusLost) target.focus({ preventScroll: true })
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      event.preventDefault()
      close()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  useEffect(() => {
    if (activeIndex < 0) return
    document.getElementById(optionId(activeIndex))?.scrollIntoView?.({ block: "nearest" })
  })

  const restoreFocus = (): void => {
    const target = returnFocus.current
    if (target?.isConnected) target.focus({ preventScroll: true })
    else inputRef.current?.blur()
  }

  const close = (): void => {
    restoreFocus()
    onClose()
  }

  const run = (item: PaletteItem | undefined): void => {
    if (!item) return
    rememberPaletteItem(item.id)
    restoreFocus()
    onClose()
    onRun(item.command)
  }

  const move = (offset: number): void => {
    if (flat.length === 0) return
    setActive((activeIndex + offset + flat.length) % flat.length)
  }

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      move(event.key === "ArrowDown" ? 1 : -1)
      return
    }
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return
    event.preventDefault()
    event.stopPropagation()
    run(flat[activeIndex])
  }

  const trapFocus = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Tab") return
    const controls = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("input, button:not(:disabled), [tabindex='0']"),
    )
    const first = controls[0]
    const last = controls.at(-1)
    if (!first || !last) return
    const current = document.activeElement
    if (event.shiftKey && current === first) {
      event.preventDefault()
      last.focus()
      return
    }
    if (!event.shiftKey && current === last) {
      event.preventDefault()
      first.focus()
    }
  }

  let position = -1
  return createPortal(
    <MotionPresence show={open} kind="modal">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: only clicking the noninteractive backdrop dismisses the dialog; Escape is handled by the dialog */}
      <div
        role="presentation"
        className="command-palette-backdrop"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) close()
        }}
      >
        <div
          className="command-palette"
          role="dialog"
          aria-modal="true"
          aria-label={PALETTE_LABEL}
          onKeyDown={trapFocus}
        >
          <div className="command-palette-input">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.7" />
              <path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-label={PALETTE_INPUT_LABEL}
              aria-expanded={open && flat.length > 0}
              aria-controls={`${baseId}-listbox`}
              aria-autocomplete="list"
              aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
              autoComplete="off"
              spellCheck={false}
              value={query}
              placeholder="Buscar bots, conversas e configurações…"
              onChange={(event) => {
                setQuery(event.target.value)
                setActive(0)
              }}
              onKeyDown={onInputKeyDown}
            />
            <kbd>Esc</kbd>
          </div>
          <div
            ref={listRef}
            id={`${baseId}-listbox`}
            className="command-palette-list"
            {...(flat.length > 0 ? { role: "listbox" as const, "aria-label": "Resultados" } : {})}
          >
            {flat.length === 0 ? (
              <p className="command-palette-empty" aria-hidden="true">
                Nenhum resultado encontrado.
              </p>
            ) : (
              groups.map((group) => (
                // biome-ignore lint/a11y/useSemanticElements: ARIA listbox groups are role="group"; a fieldset is not valid inside a listbox
                <div key={group.id} role="group" aria-labelledby={`${baseId}-group-${group.id}`}>
                  <div id={`${baseId}-group-${group.id}`} className="command-palette-group" role="presentation">
                    {group.label}
                  </div>
                  {group.items.map((item) => {
                    position += 1
                    const current = position
                    const selected = current === activeIndex
                    return (
                      // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection runs through the combobox and aria-activedescendant
                      <div
                        key={item.id}
                        id={optionId(current)}
                        role="option"
                        tabIndex={-1}
                        aria-selected={selected}
                        data-active={selected || undefined}
                        data-palette-item={item.id}
                        className="command-palette-option"
                        onMouseMove={() => {
                          if (!selected) setActive(current)
                        }}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => run(item)}
                      >
                        <span className="command-palette-option-copy">
                          <strong>{item.label}</strong>
                          {item.detail && <small>{item.detail}</small>}
                        </span>
                        <span className="command-palette-option-hint" aria-hidden="true">
                          ↵
                        </span>
                      </div>
                    )
                  })}
                </div>
              ))
            )}
          </div>
          <div className="command-palette-footer" aria-hidden="true">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> navegar
            </span>
            <span>
              <kbd>Enter</kbd> abrir
            </span>
            <span>
              <kbd>{paletteShortcutLabel()}</kbd> fechar
            </span>
          </div>
          <p className="visually-hidden" role="status" aria-live="polite">
            {open ? resultCountLabel(flat.length) : ""}
          </p>
        </div>
      </div>
    </MotionPresence>,
    document.body,
  )
}
