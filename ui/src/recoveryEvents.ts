export const resumeTaskEvent = "touri:resume-task"
export const reviewTaskEvent = "touri:review-task"
// The bot comes from the interrupted task itself, never from the latest reply in the conversation.
const pendingResumes = new Map<string, string | null>()
const pendingReviews = new Set<string>()
export const consumeTaskResume = (threadId: string): { botId: string | null } | null => {
  if (!pendingResumes.has(threadId)) return null
  const botId = pendingResumes.get(threadId) ?? null
  pendingResumes.delete(threadId)

  return { botId }
}
export const consumeTaskReview = (runId: string): boolean => pendingReviews.delete(runId)
export const requestTaskResume = (threadId: string, botId: string | null = null): void => {
  pendingResumes.set(threadId, botId)
  window.dispatchEvent(new CustomEvent(resumeTaskEvent, { detail: { threadId } }))
}
export const requestTaskReview = (runId: string): void => {
  pendingReviews.add(runId)
  window.dispatchEvent(new CustomEvent(reviewTaskEvent, { detail: { runId } }))
}
