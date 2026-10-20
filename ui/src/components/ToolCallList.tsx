import type { ApprovalPart, MessagePart } from "@touri/contracts"
import { type ReactNode, useLayoutEffect, useRef, useState } from "react"
import type { UiApi } from "../api/client"
import { t } from "../i18n"
import { ApprovalCard } from "./ApprovalCard"
import { Disclosure } from "./Disclosure"
import { ToolCallCard } from "./ToolCallCard"
import { approvalMatchesTool, type ToolPart } from "./toolPresentation"

type ToolEntry = { id: string; tool?: ToolPart; approval?: ApprovalPart }
const isTool = (part: MessagePart): part is ToolPart =>
  part.type === "tool_call" || part.type === "command" || part.type === "file_change"

const groupTools = (parts: MessagePart[]): ToolEntry[][] => {
  const matched = new Map<ToolPart, ApprovalPart>()
  const approvals = parts.filter((part) => part.type === "approval")
  const tools = parts.filter(isTool)
  const consumed = new Set<ApprovalPart>()
  for (const tool of tools) {
    const approval = approvals.find((candidate) => !consumed.has(candidate) && approvalMatchesTool(candidate, tool))
    if (approval) {
      matched.set(tool, approval)
      consumed.add(approval)
    }
  }
  const groups: ToolEntry[][] = []
  let group: ToolEntry[] = []
  for (const part of parts) {
    if (isTool(part)) {
      const approval = matched.get(part)
      group.push({ id: part.callId, tool: part, ...(approval ? { approval } : {}) })
    } else if (part.type === "approval") {
      if (!consumed.has(part)) group.push({ id: part.approvalId, approval: part })
    } else if (group.length) {
      groups.push(group)
      group = []
    }
  }
  if (group.length) groups.push(group)
  return groups
}

/** Keep historical cards dormant until their group is opened, then preserve their disclosure state. */
const ToolGroup = ({
  entries,
  focusId,
  children,
}: {
  entries: ToolEntry[]
  focusId: string | undefined
  children: ReactNode
}) => {
  const [mounted, setMounted] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const focusedApproval = entries.some((entry) => entry.approval?.approvalId === focusId)
  useLayoutEffect(() => {
    if (focusedApproval && trigger.current?.getAttribute("aria-expanded") !== "true")
      trigger.current?.focus({ preventScroll: true })
  }, [focusedApproval])
  return (
    <Disclosure
      className="tool-group"
      triggerRef={trigger}
      summary={t("Tool group count", { count: entries.length })}
      onOpenChange={(open) => {
        if (open) setMounted(true)
      }}
    >
      {mounted && <div className="tool-group-cards">{children}</div>}
    </Disclosure>
  )
}

export const ToolCallList = ({
  parts,
  api,
  finished,
  createdAt,
  onResolved,
}: {
  parts: MessagePart[]
  api?: UiApi | undefined
  finished: boolean
  createdAt: number
  onResolved?: (approvalId: string, decision: "approved" | "denied") => void
}) => {
  const root = useRef<HTMLDivElement>(null)
  const [decisions, setDecisions] = useState<Record<string, number>>({})
  const [focusId, setFocusId] = useState<string>()
  useLayoutEffect(() => {
    if (!focusId) return
    const card = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-approval-id]") ?? []).find(
      (node) => node.dataset.approvalId === focusId,
    )
    const group = card?.closest<HTMLElement>(".tool-group")
    const trigger = group?.querySelector<HTMLButtonElement>(".ds-disclosure-trigger")
    const target = group && trigger?.getAttribute("aria-expanded") !== "true" ? trigger : card
    target?.focus({ preventScroll: true })
  }, [focusId])
  const card = (entry: ToolEntry) =>
    entry.approval ? (
      <ApprovalCard
        key={entry.approval.approvalId}
        part={entry.approval}
        tool={entry.tool}
        api={api}
        finished={finished}
        createdAt={createdAt}
        resolvedAt={decisions[entry.approval.approvalId]}
        onResolved={(timestamp, decision) => {
          const id = entry.approval?.approvalId
          if (!id) return
          setDecisions((value) => ({ ...value, [id]: timestamp }))
          setFocusId(id)
          onResolved?.(id, decision)
        }}
      />
    ) : (
      <ToolCallCard key={entry.id} part={entry.tool} finished={finished} createdAt={createdAt} api={api} />
    )
  return (
    <div className="tool-call-list" ref={root}>
      {groupTools(parts).map((entries) => {
        const pending = entries.filter(
          (entry) => entry.approval?.decision === "pending" || !!entry.approval?.teamProposal,
        )
        const grouped = entries.filter(
          (entry) => entry.approval?.decision !== "pending" && !entry.approval?.teamProposal,
        )
        return (
          <div className="tool-turn" key={entries[0]?.id}>
            {grouped.length > 0 && (
              <ToolGroup entries={grouped} focusId={focusId}>
                {grouped.map(card)}
              </ToolGroup>
            )}
            {pending.map(card)}
          </div>
        )
      })}
    </div>
  )
}
