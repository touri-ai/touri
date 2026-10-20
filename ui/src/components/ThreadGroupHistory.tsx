import type { RoutineRun, Thread } from "@touri/contracts"
import { useMemo, useRef, useState } from "react"
import { getRoutineRunDateLabel, t } from "../i18n"
import { getSidebarReadThreadIds } from "../sidebarThreads"
import { getSidebarThreadTitle } from "../sidebarThreadTitle"

const PAGE_SIZE = 50

export const ThreadGroupHistory = ({
  label,
  threads,
  routineRuns,
  routineIds,
  groupThreadId,
  selectedThreadId,
  onSelectThread,
}: {
  label: string
  threads: readonly Thread[]
  routineRuns: readonly RoutineRun[]
  routineIds: ReadonlySet<string> | undefined
  groupThreadId: string
  selectedThreadId: string | null
  onSelectThread: (threadId: string) => void
}) => {
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState(0)
  const status = useRef<HTMLParagraphElement>(null)
  const historyThreads = useMemo(() => {
    if (!open) return []

    const ids = getSidebarReadThreadIds(threads, routineRuns, groupThreadId, routineIds)

    return threads.filter((thread) => ids.has(thread.id))
  }, [open, threads, routineRuns, groupThreadId, routineIds])
  const lastPage = Math.max(0, Math.ceil(historyThreads.length / PAGE_SIZE) - 1)
  const currentPage = Math.min(page, lastPage)
  const offset = currentPage * PAGE_SIZE
  const visibleThreads = historyThreads.slice(offset, offset + PAGE_SIZE)
  const showPage = (nextPage: number) => {
    setPage(nextPage)
    status.current?.focus()
  }

  return (
    <>
      <button
        type="button"
        className="new-thread-row"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current)
          setPage(0)
        }}
      >
        {label}
      </button>
      {open && (
        <section className="thread-group-history" aria-label={label}>
          <p role="status" ref={status} tabIndex={-1}>
            {t("Routine history range", {
              from: historyThreads.length ? offset + 1 : 0,
              to: offset + visibleThreads.length,
              total: historyThreads.length,
            })}
          </p>
          {visibleThreads.map((thread) => (
            <button
              type="button"
              key={thread.id}
              className={`thread-row ${thread.id === selectedThreadId ? "selected" : ""}`}
              aria-current={thread.id === selectedThreadId ? "page" : undefined}
              onClick={() => onSelectThread(thread.id)}
            >
              <span className="thread-copy">
                <strong>{getSidebarThreadTitle(thread)}</strong>
                <small>{getRoutineRunDateLabel(thread.createdAt)}</small>
              </span>
            </button>
          ))}
          {currentPage > 0 && (
            <button type="button" className="new-thread-row" onClick={() => showPage(currentPage - 1)}>
              {t("Previous routine runs page")}
            </button>
          )}
          {currentPage < lastPage && (
            <button type="button" className="new-thread-row" onClick={() => showPage(currentPage + 1)}>
              {t("Next routine runs page")}
            </button>
          )}
        </section>
      )}
    </>
  )
}
