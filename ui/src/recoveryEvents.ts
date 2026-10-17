export const resumeTaskEvent = "touri:resume-task"
export const reviewTaskEvent = "touri:review-task"
const pendingResumes = new Set<string>()
const pendingReviews = new Set<string>()
export const consumeTaskResume = (threadId: string): boolean => pendingResumes.delete(threadId)
export const consumeTaskReview = (runId: string): boolean => pendingReviews.delete(runId)
export const requestTaskResume = (threadId: string): void => {
  pendingResumes.add(threadId)
  window.dispatchEvent(new CustomEvent(resumeTaskEvent, { detail: { threadId } }))
}
export const requestTaskReview = (runId: string): void => {
  pendingReviews.add(runId)
  window.dispatchEvent(new CustomEvent(reviewTaskEvent, { detail: { runId } }))
}
