import { type ComponentProps, lazy, Suspense } from "react"
import { ConversationLoading } from "./ConversationLoading"

export const DeferredChatPanel = (props: ComponentProps<typeof ChatPanel>) => (
  <Suspense fallback={<ConversationLoading />}>
    <ChatPanel {...props} />
  </Suspense>
)

const ChatPanel = lazy(() => import("./ChatPanel").then((module) => ({ default: module.ChatPanel })))
