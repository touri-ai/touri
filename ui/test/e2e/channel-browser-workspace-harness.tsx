import { useEffect } from "react"
import { createRoot } from "react-dom/client"
import App from "../../src/App"
import { installMotionTokens } from "../../src/design/spring"
import { initializeTheme } from "../../src/design/theme"
import "../../src/styles.css"
import { getChannelBrowserWorkspaceFixture } from "../channel-browser-workspace-fixture"

const params = new URLSearchParams(location.search)
const fixture = await getChannelBrowserWorkspaceFixture({
  viewerId: params.get("viewer") ?? "owner",
  controllerId: params.get("controller") || null,
})

const Harness = () => {
  useEffect(() => {
    const finish = () => {
      fixture.emit({
        type: "browser.channel_run",
        run: Object.assign({}, fixture.browserRun, { status: "succeeded", finishedAt: Date.now() }),
      })
      fixture.emit({
        type: "run.updated",
        run: Object.assign({}, fixture.run, { status: "succeeded", finishedAt: Date.now() }),
      })
      fixture.emit({
        type: "message.updated",
        message: Object.assign({}, fixture.reply, { status: "complete", updatedAt: Date.now() }),
      })
    }
    window.addEventListener("fixture:browser-finished", finish)

    return () => window.removeEventListener("fixture:browser-finished", finish)
  }, [])

  return <App kernel={{ services: { api: fixture.api } }} />
}

installMotionTokens(document.documentElement)
initializeTheme()

const root = document.getElementById("root")
if (root) createRoot(root).render(<Harness />)
