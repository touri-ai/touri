import { Profiler } from "react"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { createApiClient, webEndpoint } from "../../src/api/client"
import { VirtualMessageList } from "../../src/components/ChatPanel"
import { Composer } from "../../src/components/Composer"
import { MarkdownContent } from "../../src/components/MarkdownContent"
import { ToolCallList } from "../../src/components/ToolCallList"
import { installMotionTokens } from "../../src/design/spring"
import { composerPerformanceMessageCount, composerPerformanceToolCount } from "./composer-performance-fixture"
import "../../src/styles.css"

const api = createApiClient({ endpoint: webEndpoint(location) })
installMotionTokens(document.documentElement)
const metrics = {
  messages: composerPerformanceMessageCount,
  toolCalls: composerPerformanceToolCount,
  initialLoadMs: 0,
  commits: [] as Array<{ at: number; duration: number; phase: string }>,
}
Object.assign(window, {
  composerPerformanceFixture: metrics,
  composerPerformanceComponents: new Map<unknown, string>([
    [VirtualMessageList, "VirtualMessageList"],
    [Composer, "Composer"],
    [MarkdownContent, "MarkdownContent"],
    [ToolCallList, "ToolCallList"],
  ]),
})
const root = document.getElementById("root")
if (!root) throw new Error("Performance fixture root is missing")
// Timestamp readiness in the browser, without including the test runner's polling delay.
const ready = new MutationObserver(() => {
  const finalHeading = root.querySelector('[data-message-id="composer-performance-message-499"] h2')
  if (!finalHeading || !root.querySelector(".composer-island textarea")) return
  ready.disconnect()
  void document.fonts.ready.then(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        metrics.initialLoadMs = performance.now()
      })
    })
  })
})
ready.observe(root, { childList: true, subtree: true })
createRoot(root).render(
  <Profiler
    id="composer-performance"
    onRender={(_id, phase, duration) => metrics.commits.push({ at: performance.now(), duration, phase })}
  >
    <App kernel={{ services: { api } }} />
  </Profiler>,
)
