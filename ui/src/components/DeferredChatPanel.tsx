import { type ComponentProps, lazy, Suspense } from "react"
import type { ChatPanel as ConversationPanel } from "./ChatPanel"
import { ConversationLoading } from "./ConversationLoading"

export const DeferredChatPanel = getDeferredChatPanel(() =>
  import("./ChatPanel").then((module) => ({ default: module.ChatPanel })),
)

export function getDeferredChatPanel(loadPanel: () => Promise<{ default: typeof ConversationPanel }>) {
  const InitialPanel = lazy(loadPanel)
  const RetryPanel = lazy(loadPanel)

  return function DeferredChatPanel({
    retry = false,
    ...props
  }: ComponentProps<typeof ConversationPanel> & { retry?: boolean }) {
    // Keep successful imports across channel switches; a retry gets its own lazy promise.
    const ChatPanel = retry ? RetryPanel : InitialPanel

    return (
      <Suspense fallback={<ConversationLoading />}>
        <ChatPanel {...props} />
      </Suspense>
    )
  }
}
