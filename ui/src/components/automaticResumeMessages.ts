import type { Message, Run } from "@touri/contracts"

/** Keep each recovery chain in its original card without changing stored history. */
export const getAutomaticResumeMessages = (messages: Message[], runs: Run[]): Message[] => {
  if (!runs.some((run) => run.automaticResumeFromRunId)) return messages

  const runsById = new Map(runs.map((run) => [run.id, run]))
  const getLineage = (runId: string): { root: string; depth: number } => {
    const visited = new Set<string>()
    let current = runId
    while (!visited.has(current) && visited.size < 32) {
      visited.add(current)
      const previous = runsById.get(current)?.automaticResumeFromRunId
      if (!previous) return { root: current, depth: visited.size - 1 }
      current = previous
    }
    return { root: runId, depth: 0 }
  }
  const lineages = new Map(runs.map((run) => [run.id, getLineage(run.id)]))
  const getRoot = (runId: string): string => lineages.get(runId)?.root ?? runId
  const getDepth = (runId: string): number => lineages.get(runId)?.depth ?? 0
  const latestRuns = runs.reduce((latest, run) => {
    const root = getRoot(run.id)
    const previous = latest.get(root)
    const depth = getDepth(run.id)
    const previousDepth = previous ? getDepth(previous.id) : -1
    if (depth > previousDepth || (depth === previousDepth && run.queuedAt >= (previous?.queuedAt ?? 0)))
      latest.set(root, run)
    return latest
  }, new Map<string, Run>())
  const chains = new Map<string, Message[]>()
  const markers = new Set(
    runs
      .filter((run) => run.automaticResumeFromRunId)
      .flatMap((run) => [run.requestMessageId, runsById.get(run.groupTurnId ?? "")?.requestMessageId]),
  )
  messages.forEach((message) => {
    if (message.role !== "assistant" || !message.runId) return
    const root = getRoot(message.runId)
    if (!latestRuns.get(root)?.automaticResumeFromRunId) return
    chains.set(root, [...(chains.get(root) ?? []), message])
  })
  // Sort disposable chains by ancestry: shared-channel reloads can deliver replies newest first.
  const orderedChains = new Map<string, Message[]>(
    [...chains].map(([root, chain]) => [
      root,
      Array.from(chain).sort(
        (first, second) =>
          getDepth(first.runId ?? "") - getDepth(second.runId ?? "") || first.createdAt - second.createdAt,
      ),
    ]),
  )
  return messages.flatMap((message) => {
    if (markers.has(message.id) && message.role === "system") return []
    if (message.role !== "assistant" || !message.runId) return [message]
    const root = getRoot(message.runId)
    const latestRun = latestRuns.get(root)
    if (!latestRun?.automaticResumeFromRunId) return [message]
    const chain = orderedChains.get(root) ?? [message]
    if (chain[0]?.id !== message.id) return []
    const latest = chain.at(-1)
    if (!latest) return [message]
    const isActive = latestRun && ["queued", "starting", "running"].includes(latestRun.status)
    if (latest.id === message.id && latestRun?.id === message.runId) return [message]
    return [
      {
        ...latest,
        id: message.id,
        runId: latestRun?.id ?? latest.runId,
        status: isActive ? "streaming" : latest.status,
        parentId: message.parentId,
        createdAt: message.createdAt,
        text: chain
          .map((item) => item.text)
          .filter(Boolean)
          .join("\n\n"),
        parts: chain.flatMap((item) =>
          item === latest && !isActive
            ? item.parts
            : item.parts.filter((part) => part.type !== "notice" || !["run_failed", "app_restart"].includes(part.code)),
        ),
      },
    ]
  })
}
